import { Router } from "express";
import bcrypt from "bcryptjs";
import { db, freelancersTable, inviteTokensTable } from "@workspace/db";
import { eq, or, and } from "drizzle-orm";
import { signToken, requireAuth } from "../lib/auth.js";
import crypto from "crypto";

const router = Router();

function normalizePhone(phone: string | null | undefined): string | null {
  if (!phone) return null;
  const digits = phone.replace(/[^\d+]/g, "");
  return digits.length >= 7 ? digits : null;
}

function generateReferralCode(id: number): string {
  return `OH-${id}-${crypto.randomBytes(4).toString("hex").toUpperCase()}`;
}

function serializeUser(user: any) {
  return {
    id: user.id,
    email: user.email,
    phone: user.phone || null,
    name: user.name,
    role: user.role || "user",
    subscription_status: user.subscription_status,
    subscription_plan: user.subscription_plan || "basic",
    subscription_expires_at: user.subscription_expires_at ? user.subscription_expires_at.toISOString() : null,
    referral_code: user.referral_code || null,
    created_at: user.created_at.toISOString(),
  };
}

router.post("/register", async (req, res) => {
  try {
    const { email, password, name, phone } = req.body;

    if (!email || !password || !name) {
      res.status(400).json({ error: "Email, password, and name are required" });
      return;
    }

    if (password.length < 6) {
      res.status(400).json({ error: "Password must be at least 6 characters" });
      return;
    }

    const normalizedPhone = normalizePhone(phone);
    const conditions: any[] = [eq(freelancersTable.email, email)];
    if (normalizedPhone) {
      conditions.push(eq(freelancersTable.phone, normalizedPhone));
    }

    const existing = await db.select().from(freelancersTable).where(or(...conditions)).limit(1);
    if (existing.length > 0) {
      res.status(409).json({ error: "This email or phone number is already registered." });
      return;
    }

    const password_hash = await bcrypt.hash(password, 10);

    const [user] = await db.insert(freelancersTable).values({
      email,
      phone: normalizedPhone,
      password_hash,
      name,
      role: "user",
      subscription_status: "trial",
      subscription_plan: "basic",
    }).returning();

    const referral_code = generateReferralCode(user.id);
    await db.update(freelancersTable).set({ referral_code }).where(eq(freelancersTable.id, user.id));

    const updatedUser = { ...user, referral_code };
    const token = signToken({ id: user.id, email: user.email });

    res.cookie("token", token, { httpOnly: true, sameSite: "lax", maxAge: 7 * 24 * 60 * 60 * 1000 });

    res.status(201).json({
      user: serializeUser(updatedUser),
      token,
    });
  } catch (err) {
    console.error("Register error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

router.get("/invite/:token", async (req, res) => {
  try {
    const { token } = req.params;
    const [invite] = await db.select().from(inviteTokensTable).where(and(eq(inviteTokensTable.token, token), eq(inviteTokensTable.used, false))).limit(1);
    if (!invite) {
      res.status(404).json({ error: "Invalid or expired invite link" });
      return;
    }
    const existing = await db.select({ id: freelancersTable.id }).from(freelancersTable).where(eq(freelancersTable.email, invite.email)).limit(1);
    if (existing.length > 0) {
      res.status(409).json({ error: "This email is already registered" });
      return;
    }
    res.json({ email: invite.email, phone: invite.phone, name: invite.name, plan: invite.plan, trial_days: invite.trial_days });
  } catch (err) {
    console.error("Invite verify error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

router.post("/invite/:token/register", async (req, res) => {
  try {
    const { token } = req.params;
    const { password, name, phone } = req.body;
    if (!password || password.length < 6) {
      res.status(400).json({ error: "Password must be at least 6 characters" });
      return;
    }
    const userPhone = normalizePhone(phone) || null;
    const password_hash = await bcrypt.hash(password, 10);
    const result = await db.transaction(async (tx) => {
      const [invite] = await tx.select().from(inviteTokensTable).where(and(eq(inviteTokensTable.token, token), eq(inviteTokensTable.used, false))).limit(1);
      if (!invite) return { error: "Invalid or expired invite link", status: 404 };
      const existing = await tx.select({ id: freelancersTable.id }).from(freelancersTable).where(eq(freelancersTable.email, invite.email)).limit(1);
      if (existing.length > 0) return { error: "This email is already registered", status: 409 };
      const finalPhone = userPhone || normalizePhone(invite.phone) || null;
      if (finalPhone) {
        const phoneExists = await tx.select({ id: freelancersTable.id }).from(freelancersTable).where(eq(freelancersTable.phone, finalPhone)).limit(1);
        if (phoneExists.length > 0) return { error: "This phone number is already registered to another account", status: 409 };
      }
      const trialDays = parseInt(invite.trial_days) || 14;
      const expiresAt = new Date();
      expiresAt.setDate(expiresAt.getDate() + trialDays);
      const [user] = await tx.insert(freelancersTable).values({
        email: invite.email,
        phone: finalPhone,
        password_hash,
        name: name || invite.name || invite.email.split("@")[0],
        role: "user",
        subscription_status: "trial",
        subscription_plan: invite.plan || "basic",
        subscription_expires_at: expiresAt,
      }).returning();
      const referral_code = generateReferralCode(user.id);
      await tx.update(freelancersTable).set({ referral_code }).where(eq(freelancersTable.id, user.id));
      await tx.update(inviteTokensTable).set({ used: true, used_at: new Date() }).where(eq(inviteTokensTable.id, invite.id));
      return { user: { ...user, referral_code } };
    });
    if ("error" in result) {
      res.status(result.status as number).json({ error: result.error });
      return;
    }
    const authToken = signToken({ id: result.user.id, email: result.user.email });
    res.cookie("token", authToken, { httpOnly: true, sameSite: "lax", maxAge: 7 * 24 * 60 * 60 * 1000 });
    res.status(201).json({
      user: serializeUser(result.user),
      token: authToken,
    });
  } catch (err) {
    console.error("Invite register error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

router.post("/login", async (req, res) => {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      res.status(400).json({ error: "Email and password are required" });
      return;
    }

    const [user] = await db.select().from(freelancersTable).where(eq(freelancersTable.email, email)).limit(1);

    if (!user) {
      res.status(401).json({ error: "Invalid credentials" });
      return;
    }

    const valid = await bcrypt.compare(password, user.password_hash);
    if (!valid) {
      res.status(401).json({ error: "Invalid credentials" });
      return;
    }

    if (!user.referral_code) {
      const referral_code = generateReferralCode(user.id);
      await db.update(freelancersTable).set({ referral_code }).where(eq(freelancersTable.id, user.id));
      user.referral_code = referral_code;
    }

    const token = signToken({ id: user.id, email: user.email });

    res.cookie("token", token, { httpOnly: true, sameSite: "lax", maxAge: 7 * 24 * 60 * 60 * 1000 });

    res.json({
      user: serializeUser(user),
      token,
    });
  } catch (err) {
    console.error("Login error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

router.post("/logout", (req, res) => {
  res.clearCookie("token");
  res.json({ message: "Logged out successfully" });
});

router.get("/me", requireAuth, async (req, res) => {
  try {
    const userId = (req as any).user.id;
    const [user] = await db.select().from(freelancersTable).where(eq(freelancersTable.id, userId)).limit(1);

    if (!user) {
      res.status(401).json({ error: "User not found" });
      return;
    }

    if (!user.referral_code) {
      const referral_code = generateReferralCode(user.id);
      await db.update(freelancersTable).set({ referral_code }).where(eq(freelancersTable.id, user.id));
      user.referral_code = referral_code;
    }

    res.json(serializeUser(user));
  } catch (err) {
    console.error("GetMe error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

export default router;
