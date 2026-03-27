import { Router } from "express";
import crypto from "crypto";
import { db, freelancersTable, freelancerDashboardTable, leadViewsTable, leadContactsTable, inviteTokensTable } from "@workspace/db";
import { requireAuth } from "../lib/auth.js";
import { eq, and, or, sql } from "drizzle-orm";
import { supabase, sbQuery } from "../lib/supabase.js";
import { runCollector } from "../services/lead-collector.js";

const router = Router();

function requireAdmin(req: any, res: any, next: any) {
  if (req.userRole !== "admin") {
    res.status(403).json({ error: "Admin access required" });
    return;
  }
  next();
}

async function attachRole(req: any, res: any, next: any) {
  if (req.user) {
    const [u] = await db.select({ role: freelancersTable.role }).from(freelancersTable).where(eq(freelancersTable.id, req.user.id)).limit(1);
    req.userRole = u?.role || "user";
  }
  next();
}

router.get("/users", requireAuth, attachRole, requireAdmin, async (req, res) => {
  try {
    const users = await db.select({
      id: freelancersTable.id,
      name: freelancersTable.name,
      email: freelancersTable.email,
      phone: freelancersTable.phone,
      role: freelancersTable.role,
      subscription_status: freelancersTable.subscription_status,
      subscription_plan: freelancersTable.subscription_plan,
      subscription_expires_at: freelancersTable.subscription_expires_at,
      referral_code: freelancersTable.referral_code,
      referred_by: freelancersTable.referred_by,
      created_at: freelancersTable.created_at,
    }).from(freelancersTable).orderBy(freelancersTable.created_at);

    res.json(users.map(u => ({
      ...u,
      subscription_expires_at: u.subscription_expires_at ? u.subscription_expires_at.toISOString() : null,
      created_at: u.created_at.toISOString(),
    })));
  } catch (err) {
    console.error("Admin users error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

router.get("/resellers", requireAuth, attachRole, requireAdmin, async (req, res) => {
  try {
    const resellers = await db.select().from(freelancersTable).where(eq(freelancersTable.role, "reseller"));
    const allUsers = await db.select({
      referred_by: freelancersTable.referred_by,
      subscription_status: freelancersTable.subscription_status,
      subscription_plan: freelancersTable.subscription_plan,
    }).from(freelancersTable);

    const summary = resellers.map(r => {
      const referredUsers = allUsers.filter(u => u.referred_by === r.referral_code);
      const activeMembers = referredUsers.filter(u => u.subscription_status === "active" || u.subscription_status === "trial");
      const totalSales = referredUsers.filter(u => u.subscription_status === "active").length;
      const goldSales = referredUsers.filter(u => u.subscription_plan === "gold" && u.subscription_status === "active").length;
      const bonusSales = Math.floor(totalSales / 5);
      const totalCommission30 = totalSales - bonusSales;
      return {
        id: r.id,
        name: r.name,
        email: r.email,
        referral_code: r.referral_code,
        total_referrals: referredUsers.length,
        active_members: activeMembers.length,
        total_subscription_sales: totalSales,
        bonus_100_percent_count: bonusSales,
        gold_sales: goldSales,
        commission_30_count: totalCommission30,
        created_at: r.created_at.toISOString(),
      };
    });
    res.json(summary);
  } catch (err) {
    console.error("Admin resellers error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

router.patch("/users/:id/role", requireAuth, attachRole, requireAdmin, async (req, res) => {
  try {
    const userId = parseInt(String(req.params.id));
    const { role } = req.body;
    if (!["user", "reseller", "admin"].includes(role)) {
      res.status(400).json({ error: "Invalid role" });
      return;
    }
    await db.update(freelancersTable).set({ role }).where(eq(freelancersTable.id, userId));
    res.json({ message: "Role updated" });
  } catch (err) {
    console.error("Update role error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

router.patch("/users/:id/subscription", requireAuth, attachRole, requireAdmin, async (req, res) => {
  try {
    const userId = parseInt(String(req.params.id));
    const { status, plan, expires_at, duration_days } = req.body;
    const validStatuses = ["trial", "active", "inactive"];
    const validPlans = ["basic", "premium", "gold"];
    if (status && !validStatuses.includes(status)) {
      res.status(400).json({ error: "Invalid status" });
      return;
    }
    if (plan && !validPlans.includes(plan)) {
      res.status(400).json({ error: "Invalid plan" });
      return;
    }
    const updates: any = {};
    if (status) updates.subscription_status = status;
    if (plan) updates.subscription_plan = plan;
    if (duration_days && parseInt(duration_days) > 0) {
      const expiry = new Date();
      expiry.setDate(expiry.getDate() + parseInt(duration_days));
      updates.subscription_expires_at = expiry;
      if (!status) updates.subscription_status = "active";
    } else if (expires_at !== undefined) {
      updates.subscription_expires_at = expires_at ? new Date(expires_at) : null;
    }
    await db.update(freelancersTable).set(updates).where(eq(freelancersTable.id, userId));
    res.json({ message: "Subscription updated" });
  } catch (err) {
    console.error("Update subscription error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

router.patch("/leads/:id/verify", requireAuth, attachRole, requireAdmin, async (req, res) => {
  try {
    const leadId = parseInt(String(req.params.id));
    const { verified_status } = req.body;
    const valid = ["verified", "unverified", "spam"];
    if (!valid.includes(verified_status)) {
      res.status(400).json({ error: "Invalid verified_status" });
      return;
    }
    await db.update(freelancerDashboardTable).set({ verified_status }).where(eq(freelancerDashboardTable.id, leadId));
    res.json({ message: "Lead status updated" });
  } catch (err) {
    console.error("Verify lead error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

router.get("/leads", requireAuth, attachRole, requireAdmin, async (req, res) => {
  try {
    const leads = await db.select().from(freelancerDashboardTable).orderBy(freelancerDashboardTable.created_at);
    res.json(leads.map(l => ({
      ...l,
      created_at: l.created_at.toISOString(),
      fetched_at: l.fetched_at ? l.fetched_at.toISOString() : null,
    })));
  } catch (err) {
    console.error("Admin leads error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

router.post("/leads", requireAuth, attachRole, requireAdmin, async (req, res) => {
  try {
    const { client_name, service_needed, lead_quality, description, budget, country, city, industry, contact_email, contact_phone, source_url, verified_status } = req.body;
    if (!client_name || !service_needed) {
      res.status(400).json({ error: "client_name and service_needed are required" });
      return;
    }
    if (contact_email || contact_phone || source_url) {
      const conditions: any[] = [];
      if (contact_email) conditions.push(eq(freelancerDashboardTable.contact_email, contact_email));
      if (contact_phone) conditions.push(eq(freelancerDashboardTable.contact_phone, contact_phone));
      if (source_url) conditions.push(eq(freelancerDashboardTable.source_url, source_url));
      const existing = await db.select({ id: freelancerDashboardTable.id })
        .from(freelancerDashboardTable)
        .where(or(...conditions))
        .limit(1);
      if (existing.length > 0) {
        res.status(409).json({ error: "Duplicate lead detected (same email, phone, or source URL already exists)" });
        return;
      }
    }
    const now = new Date();
    const [newLead] = await db.insert(freelancerDashboardTable).values({
      client_name, service_needed,
      lead_quality: lead_quality || "MEDIUM",
      description, budget, country, city, industry,
      contact_email, contact_phone, source_url,
      verified_status: verified_status || "unverified",
      fetched_at: now,
    }).returning();
    res.json({ message: "Lead created", lead: { ...newLead, created_at: newLead.created_at.toISOString(), fetched_at: newLead.fetched_at ? newLead.fetched_at.toISOString() : null } });
  } catch (err) {
    console.error("Create lead error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

router.delete("/leads/:id", requireAuth, attachRole, requireAdmin, async (req, res) => {
  try {
    const leadId = parseInt(String(req.params.id));
    if (!Number.isFinite(leadId)) {
      res.status(400).json({ error: "Invalid lead ID" });
      return;
    }
    await db.transaction(async (tx) => {
      await tx.delete(leadViewsTable).where(eq(leadViewsTable.lead_id, leadId));
      await tx.delete(leadContactsTable).where(eq(leadContactsTable.lead_id, leadId));
      await tx.delete(freelancerDashboardTable).where(eq(freelancerDashboardTable.id, leadId));
    });
    res.json({ message: "Lead deleted" });
  } catch (err) {
    console.error("Delete lead error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

router.get("/subscription-link/:userId", requireAuth, attachRole, requireAdmin, async (req, res) => {
  try {
    const userId = parseInt(String(req.params.userId));
    const [user] = await db.select({ email: freelancersTable.email }).from(freelancersTable).where(eq(freelancersTable.id, userId)).limit(1);
    if (!user) {
      res.status(404).json({ error: "User not found" });
      return;
    }
    const link = `https://opportunity-hub.replit.app/subscribe?email=${encodeURIComponent(user.email)}`;
    res.json({ link });
  } catch (err) {
    console.error("Sub link error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

router.post("/invite", requireAuth, attachRole, requireAdmin, async (req, res) => {
  try {
    const { email, phone, name, plan, trial_days } = req.body;
    if (!email) {
      res.status(400).json({ error: "Email is required" });
      return;
    }
    const existing = await db.select({ id: freelancersTable.id }).from(freelancersTable).where(eq(freelancersTable.email, email)).limit(1);
    if (existing.length > 0) {
      res.status(409).json({ error: "This email is already registered" });
      return;
    }
    if (phone) {
      const phoneExists = await db.select({ id: freelancersTable.id }).from(freelancersTable).where(eq(freelancersTable.phone, phone)).limit(1);
      if (phoneExists.length > 0) {
        res.status(409).json({ error: "This phone number is already registered" });
        return;
      }
    }
    const existingInvite = await db.select().from(inviteTokensTable).where(and(eq(inviteTokensTable.email, email), eq(inviteTokensTable.used, false))).limit(1);
    if (existingInvite.length > 0) {
      const baseUrl = req.headers.origin || req.headers.referer?.replace(/\/$/, "") || "https://opportunity-hub.replit.app";
      res.json({ message: "Invite already exists for this email", token: existingInvite[0].token, link: `${baseUrl}/invite/${existingInvite[0].token}` });
      return;
    }
    const token = crypto.randomBytes(24).toString("hex");
    const [invite] = await db.insert(inviteTokensTable).values({
      token,
      email,
      phone: phone || null,
      name: name || null,
      plan: plan || "basic",
      trial_days: String(trial_days || 14),
      created_by: (req as any).user?.email || "admin",
    }).returning();
    const baseUrl = req.headers.origin || req.headers.referer?.replace(/\/$/, "") || "https://opportunity-hub.replit.app";
    const link = `${baseUrl}/invite/${token}`;
    res.json({ message: "Invite created", token, link, invite });
  } catch (err) {
    console.error("Create invite error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

router.get("/invites", requireAuth, attachRole, requireAdmin, async (req, res) => {
  try {
    const invites = await db.select().from(inviteTokensTable).orderBy(sql`created_at DESC`);
    res.json(invites);
  } catch (err) {
    console.error("List invites error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

router.delete("/invites/:id", requireAuth, attachRole, requireAdmin, async (req, res) => {
  try {
    const id = parseInt(String(req.params.id));
    await db.delete(inviteTokensTable).where(eq(inviteTokensTable.id, id));
    res.json({ message: "Invite deleted" });
  } catch (err) {
    console.error("Delete invite error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

router.get("/sb/subscriptions", requireAuth, attachRole, requireAdmin, async (req, res) => {
  try {
    const subs = await sbQuery("subscriptions", q =>
      q.select("*").order("created_at", { ascending: false })
    );
    console.log(`[Admin] Fetched ${subs.length} subscriptions from Supabase`);
    res.json(subs);
  } catch (err) {
    console.error("[Admin] sb/subscriptions error:", err);
    res.status(500).json({ error: "Failed to fetch subscriptions from Supabase" });
  }
});

router.patch("/sb/subscriptions/:id", requireAuth, attachRole, requireAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    const updates = req.body;
    if (!supabase) {
      res.status(503).json({ error: "Supabase not configured" });
      return;
    }
    const { data, error } = await supabase.from("subscriptions").update(updates).eq("id", id).select().single();
    if (error) {
      console.error("[Admin] update subscription error:", error.message);
      res.status(400).json({ error: error.message });
      return;
    }
    console.log(`[Admin] Updated subscription ${id}:`, updates);
    res.json({ message: "Subscription updated", subscription: data });
  } catch (err) {
    console.error("[Admin] sb/subscriptions PATCH error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

router.post("/sb/subscriptions", requireAuth, attachRole, requireAdmin, async (req, res) => {
  try {
    if (!supabase) {
      res.status(503).json({ error: "Supabase not configured" });
      return;
    }
    const { data, error } = await supabase.from("subscriptions").insert(req.body).select().single();
    if (error) {
      console.error("[Admin] create subscription error:", error.message);
      res.status(400).json({ error: error.message });
      return;
    }
    res.status(201).json({ message: "Subscription created", subscription: data });
  } catch (err) {
    console.error("[Admin] sb/subscriptions POST error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

router.get("/sb/plans", requireAuth, attachRole, requireAdmin, async (req, res) => {
  try {
    const plans = await sbQuery("plans", q =>
      q.select("*").order("price", { ascending: true })
    );
    console.log(`[Admin] Fetched ${plans.length} plans from Supabase`);
    res.json(plans);
  } catch (err) {
    console.error("[Admin] sb/plans error:", err);
    res.status(500).json({ error: "Failed to fetch plans" });
  }
});

router.post("/sb/plans", requireAuth, attachRole, requireAdmin, async (req, res) => {
  try {
    if (!supabase) {
      res.status(503).json({ error: "Supabase not configured" });
      return;
    }
    const allowedCols = ["name", "price", "currency", "campaign_limit", "lead_limit", "csv_upload_limit"];
    const filtered: Record<string, any> = {};
    for (const key of allowedCols) {
      if (req.body[key] !== undefined && req.body[key] !== null) filtered[key] = req.body[key];
    }
    if (!filtered.campaign_limit) filtered.campaign_limit = 5;
    if (!filtered.lead_limit) filtered.lead_limit = 100;
    if (!filtered.csv_upload_limit) filtered.csv_upload_limit = 50;
    const { data, error } = await supabase.from("plans").insert(filtered).select().single();
    if (error) {
      console.error("[Admin] create plan error:", error.message);
      res.status(400).json({ error: error.message });
      return;
    }
    res.status(201).json({ message: "Plan created", plan: data });
  } catch (err) {
    console.error("[Admin] sb/plans POST error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

router.patch("/sb/plans/:id", requireAuth, attachRole, requireAdmin, async (req, res) => {
  try {
    if (!supabase) {
      res.status(503).json({ error: "Supabase not configured" });
      return;
    }
    const { data, error } = await supabase.from("plans").update(req.body).eq("id", req.params.id).select().single();
    if (error) {
      console.error("[Admin] update plan error:", error.message);
      res.status(400).json({ error: error.message });
      return;
    }
    res.json({ message: "Plan updated", plan: data });
  } catch (err) {
    res.status(500).json({ error: "Internal server error" });
  }
});

router.delete("/sb/plans/:id", requireAuth, attachRole, requireAdmin, async (req, res) => {
  try {
    if (!supabase) {
      res.status(503).json({ error: "Supabase not configured" });
      return;
    }
    const { error } = await supabase.from("plans").delete().eq("id", req.params.id);
    if (error) {
      res.status(400).json({ error: error.message });
      return;
    }
    res.json({ message: "Plan deleted" });
  } catch (err) {
    res.status(500).json({ error: "Internal server error" });
  }
});

router.get("/sb/resellers", requireAuth, attachRole, requireAdmin, async (req, res) => {
  try {
    const resellers = await sbQuery("resellers", q =>
      q.select("*").order("created_at", { ascending: false })
    );
    console.log(`[Admin] Fetched ${resellers.length} resellers from Supabase`);
    res.json(resellers);
  } catch (err) {
    console.error("[Admin] sb/resellers error:", err);
    res.status(500).json({ error: "Failed to fetch resellers" });
  }
});

router.post("/sb/resellers", requireAuth, attachRole, requireAdmin, async (req, res) => {
  try {
    if (!supabase) {
      res.status(503).json({ error: "Supabase not configured" });
      return;
    }
    const { data, error } = await supabase.from("resellers").insert(req.body).select().single();
    if (error) {
      console.error("[Admin] create reseller error:", error.message);
      res.status(400).json({ error: error.message });
      return;
    }
    res.status(201).json({ message: "Reseller added", reseller: data });
  } catch (err) {
    res.status(500).json({ error: "Internal server error" });
  }
});

router.delete("/sb/resellers/:id", requireAuth, attachRole, requireAdmin, async (req, res) => {
  try {
    if (!supabase) {
      res.status(503).json({ error: "Supabase not configured" });
      return;
    }
    const { error } = await supabase.from("resellers").delete().eq("id", req.params.id);
    if (error) {
      res.status(400).json({ error: error.message });
      return;
    }
    res.json({ message: "Reseller removed" });
  } catch (err) {
    res.status(500).json({ error: "Internal server error" });
  }
});

router.get("/sb/referrals", requireAuth, attachRole, requireAdmin, async (req, res) => {
  try {
    const referrals = await sbQuery("referrals", q =>
      q.select("*").order("created_at", { ascending: false })
    );
    console.log(`[Admin] Fetched ${referrals.length} referrals from Supabase`);
    res.json(referrals);
  } catch (err) {
    console.error("[Admin] sb/referrals error:", err);
    res.status(500).json({ error: "Failed to fetch referrals" });
  }
});

router.post("/seed-leads", requireAuth, attachRole, requireAdmin, async (req, res) => {
  try {
    const now = new Date();
    const leads = [
      { client_name: "Upwork — Web Developer needed for E-commerce Site", service_needed: "Web Development", description: "Client on Upwork needs a Shopify/WooCommerce developer to build an online store. Budget $500-$2000. Apply directly on Upwork.", industry: "Technology", country: "Remote", city: "Worldwide", budget: "$500-$2000", source_url: "https://www.upwork.com/freelance-jobs/web-development/", source: "upwork.com", lead_quality: "HOT", lead_score: 90, contact_email: "", contact_phone: "", lead_text: "Multiple web development jobs posted daily. Filter by your rate and skills." },
      { client_name: "Fiverr — Graphic Design Gigs Available", service_needed: "Graphic Design", description: "Active buyers looking for logo design, brand identity, social media graphics. Create your gig and start getting orders.", industry: "Creative & Design", country: "Remote", city: "Worldwide", budget: "$25-$500", source_url: "https://www.fiverr.com/categories/graphics-design", source: "fiverr.com", lead_quality: "HOT", lead_score: 85, contact_email: "", contact_phone: "", lead_text: "Set up a gig with portfolio samples. Buyers search and order directly." },
      { client_name: "Preply — Arabic/Quran Tutors Needed (High Demand)", service_needed: "Teaching & Coaching", description: "Preply has high demand for Arabic language and Quran tutors. Set your own rate ($10-50/hr). Students book and pay through the platform.", industry: "Education", country: "Remote", city: "Worldwide", budget: "$10-50/hour", source_url: "https://preply.com/en/teach", source: "preply.com", lead_quality: "HOT", lead_score: 92, contact_email: "", contact_phone: "", lead_text: "Create a tutor profile, set availability, students find and book you." },
      { client_name: "iTalki — English/Language Teachers Wanted", service_needed: "Teaching & Coaching", description: "iTalki connects language teachers with students globally. Teach English, Arabic, Urdu, or any language. Flexible hours, set your own price.", industry: "Education", country: "Remote", city: "Worldwide", budget: "$8-40/hour", source_url: "https://www.italki.com/en/teacher/apply", source: "italki.com", lead_quality: "HOT", lead_score: 88, contact_email: "", contact_phone: "", lead_text: "Apply as a community tutor or professional teacher." },
      { client_name: "Toptal — Senior Developer/Designer Positions", service_needed: "Web Development", description: "Toptal matches top freelance developers and designers with clients. Higher rates ($50-150/hr) but requires screening test.", industry: "Technology", country: "Remote", city: "Worldwide", budget: "$50-150/hour", source_url: "https://www.toptal.com/freelance-jobs", source: "toptal.com", lead_quality: "HOT", lead_score: 95, contact_email: "", contact_phone: "", lead_text: "Apply, pass screening, get matched with premium clients." },
      { client_name: "PeoplePerHour — Freelance Projects (UK Focus)", service_needed: "Freelance Services", description: "UK-based freelance marketplace. Web dev, design, writing, marketing projects. Post your offers or bid on projects.", industry: "Technology", country: "UK", city: "London", budget: "$100-$5000", source_url: "https://www.peopleperhour.com/freelance-jobs", source: "peopleperhour.com", lead_quality: "GOOD", lead_score: 75, contact_email: "", contact_phone: "", lead_text: "Strong demand for web development and digital marketing." },
      { client_name: "Guru — Freelance Writing & Content Jobs", service_needed: "Content Writing", description: "Find content writing, copywriting, and blog writing jobs. Multiple active postings daily. Free to join and bid.", industry: "Marketing", country: "Remote", city: "Worldwide", budget: "$50-$1000", source_url: "https://www.guru.com/d/jobs/c/writing-translation/", source: "guru.com", lead_quality: "GOOD", lead_score: 70, contact_email: "", contact_phone: "", lead_text: "Filter by category, budget, and location. Submit proposals directly." },
      { client_name: "99designs — Logo & Brand Design Contests", service_needed: "Logo & Branding Design", description: "Compete in design contests or get hired directly. Logo design, brand identity, packaging. Win contests to earn $200-$1500+.", industry: "Creative & Design", country: "Remote", city: "Worldwide", budget: "$200-$1500", source_url: "https://99designs.com/designers", source: "99designs.com", lead_quality: "GOOD", lead_score: 72, contact_email: "", contact_phone: "", lead_text: "Submit designs in open contests. Win to get paid." },
      { client_name: "Wyzant — Online Tutoring (Math, Science, Languages)", service_needed: "Teaching & Coaching", description: "US-focused tutoring marketplace. High demand for math, science, test prep, and language tutors. Set your rate $20-80/hr.", industry: "Education", country: "USA", city: "Nationwide", budget: "$20-80/hour", source_url: "https://www.wyzant.com/tutorjobs", source: "wyzant.com", lead_quality: "HOT", lead_score: 85, contact_email: "", contact_phone: "", lead_text: "Create profile, pass background check, start tutoring." },
      { client_name: "Freelancer.com — PHP/WordPress Developer Needed", service_needed: "Web Development", description: "Active project postings for PHP, WordPress, React developers. Bid on projects, compete on price and quality.", industry: "Technology", country: "Remote", city: "Worldwide", budget: "$100-$3000", source_url: "https://www.freelancer.com/jobs/php/", source: "freelancer.com", lead_quality: "GOOD", lead_score: 68, contact_email: "", contact_phone: "", lead_text: "Browse projects, submit proposals, get hired." },
      { client_name: "Foodpanda Partner — Restaurant/HomeChef Registration", service_needed: "Food Business", description: "Register as a food delivery partner on Foodpanda. Home chefs and small restaurants can sign up to receive orders.", industry: "Food & Hospitality", country: "Pakistan", city: "Lahore", budget: "Commission-based", source_url: "https://www.foodpanda.pk/restaurant/join", source: "foodpanda.pk", lead_quality: "HOT", lead_score: 88, contact_email: "partner@foodpanda.pk", contact_phone: "", lead_text: "Register your kitchen, set menu, start receiving orders." },
      { client_name: "Daraz Seller — Start Selling Food Products Online", service_needed: "Food Business", description: "Sell packaged food, snacks, spices on Daraz. Free registration. Great for home-based food businesses in Pakistan.", industry: "Food & Hospitality", country: "Pakistan", city: "Nationwide", budget: "Commission-based", source_url: "https://sellercenter.daraz.pk/", source: "daraz.pk", lead_quality: "GOOD", lead_score: 75, contact_email: "", contact_phone: "", lead_text: "Register as seller, list products, Daraz handles delivery." },
      { client_name: "Talabat Partner — UAE Kitchen Registration", service_needed: "Food Business", description: "Register your home kitchen or restaurant on Talabat. Receive food delivery orders across UAE, Saudi Arabia, Qatar.", industry: "Food & Hospitality", country: "UAE", city: "Dubai", budget: "Commission-based", source_url: "https://www.talabat.com/uae/partner", source: "talabat.com", lead_quality: "HOT", lead_score: 85, contact_email: "", contact_phone: "", lead_text: "Cloud kitchen friendly. Register and start getting orders." },
      { client_name: "Careem Food — Home Chef Partner (Pakistan/UAE)", service_needed: "Food Business", description: "Careem's food delivery platform accepts home chefs. Register your kitchen to get food delivery orders in Pakistan and UAE.", industry: "Food & Hospitality", country: "Pakistan", city: "Karachi", budget: "Commission-based", source_url: "https://www.careem.com/en-pk/food-partners/", source: "careem.com", lead_quality: "GOOD", lead_score: 78, contact_email: "", contact_phone: "", lead_text: "Partner with Careem Food to reach more customers." },
      { client_name: "LinkedIn ProFinder — Freelance Consulting Projects", service_needed: "Business Consulting", description: "Get matched with businesses needing consultants, coaches, and professional services through LinkedIn.", industry: "Business Services", country: "Remote", city: "Worldwide", budget: "$500-$5000", source_url: "https://www.linkedin.com/profinder", source: "linkedin.com", lead_quality: "GOOD", lead_score: 72, contact_email: "", contact_phone: "", lead_text: "Create a ProFinder profile. LinkedIn sends you RFPs from businesses." },
      { client_name: "Superprof — Private Tutoring Jobs (Worldwide)", service_needed: "Teaching & Coaching", description: "Register as a tutor for any subject. Students in your area contact you directly. Set your own rate. Available in 40+ countries.", industry: "Education", country: "Remote", city: "Worldwide", budget: "$10-60/hour", source_url: "https://www.superprof.com/registration/teacher/", source: "superprof.com", lead_quality: "GOOD", lead_score: 74, contact_email: "", contact_phone: "", lead_text: "Register free, students in your city find you." },
      { client_name: "Cambly — Teach English Online (No Degree Required)", service_needed: "Teaching & Coaching", description: "Chat with English learners worldwide. No teaching degree required. Earn $0.17/min ($10.20/hr). Flexible schedule.", industry: "Education", country: "Remote", city: "Worldwide", budget: "$10/hour", source_url: "https://www.cambly.com/en/tutors?lang=en", source: "cambly.com", lead_quality: "HOT", lead_score: 82, contact_email: "", contact_phone: "", lead_text: "Sign up, set availability, students call you for conversation practice." },
      { client_name: "Dribbble Jobs — UI/UX & Graphic Design Positions", service_needed: "UI/UX Design", description: "Browse design jobs from top companies. Remote and on-site positions for UI/UX designers, illustrators, brand designers.", industry: "Creative & Design", country: "Remote", city: "Worldwide", budget: "$2000-$8000/mo", source_url: "https://dribbble.com/jobs", source: "dribbble.com", lead_quality: "GOOD", lead_score: 70, contact_email: "", contact_phone: "", lead_text: "Upload portfolio shots, get discovered by hiring managers." },
      { client_name: "Cheetay/Golootlo — Food Partner Registration (Lahore)", service_needed: "Food Business", description: "Register your food business on local delivery platforms in Lahore. Home chefs and restaurants welcome.", industry: "Food & Hospitality", country: "Pakistan", city: "Lahore", budget: "Commission-based", source_url: "https://cheetay.pk/become-a-vendor", source: "cheetay.pk", lead_quality: "GOOD", lead_score: 72, contact_email: "", contact_phone: "", lead_text: "Local delivery platform with growing customer base in Lahore." },
      { client_name: "Tutors.com — Find Students in Saudi Arabia", service_needed: "Teaching & Coaching", description: "Platform connecting tutors with students in Saudi Arabia. High demand for English, Math, Science tutors. Good rates.", industry: "Education", country: "Saudi Arabia", city: "Riyadh", budget: "SAR 100-300/hour", source_url: "https://www.tutors.com/", source: "tutors.com", lead_quality: "GOOD", lead_score: 74, contact_email: "", contact_phone: "", lead_text: "Register as a tutor, set subjects and availability." },
      { client_name: "Noon Food — Cloud Kitchen Partner (UAE/KSA)", service_needed: "Food Business", description: "Noon's food delivery service accepts cloud kitchen and home chef partners in UAE and Saudi Arabia.", industry: "Food & Hospitality", country: "UAE", city: "Dubai", budget: "Commission-based", source_url: "https://food.noon.com/", source: "noon.com", lead_quality: "GOOD", lead_score: 73, contact_email: "", contact_phone: "", lead_text: "Growing food delivery platform in Gulf region." },
      { client_name: "Bark.com — Local Service Leads (UK/USA/AUS)", service_needed: "Freelance Services", description: "Get matched with local clients needing services: web design, photography, tutoring, personal training, catering. Buy leads.", industry: "Business Services", country: "UK", city: "Nationwide", budget: "$50-$2000", source_url: "https://www.bark.com/en/gb/join-as-professional/", source: "bark.com", lead_quality: "HOT", lead_score: 80, contact_email: "", contact_phone: "", lead_text: "Register your services, get real client requests with contact details." },
      { client_name: "Thumbtack — Get Hired for Local Services (USA)", service_needed: "Freelance Services", description: "Clients post projects (tutoring, photography, web design, catering). You respond with quotes. USA-focused.", industry: "Business Services", country: "USA", city: "Nationwide", budget: "$50-$5000", source_url: "https://www.thumbtack.com/pro", source: "thumbtack.com", lead_quality: "HOT", lead_score: 82, contact_email: "", contact_phone: "", lead_text: "Create profile, set services, respond to customer requests." },
      { client_name: "Airtasker — Get Hired (Australia/UK)", service_needed: "Freelance Services", description: "Clients post tasks from web development to deliveries. Bid on tasks near you. Strong in Australia and UK market.", industry: "Business Services", country: "Australia", city: "Nationwide", budget: "$30-$2000", source_url: "https://www.airtasker.com/earn-money/", source: "airtasker.com", lead_quality: "GOOD", lead_score: 75, contact_email: "", contact_phone: "", lead_text: "Browse posted tasks, make offers, get hired." },
      { client_name: "Zomato Partner — Restaurant Registration (Pakistan/UAE/India)", service_needed: "Food Business", description: "List your restaurant or home kitchen on Zomato for food delivery orders. Available in multiple countries.", industry: "Food & Hospitality", country: "Pakistan", city: "Islamabad", budget: "Commission-based", source_url: "https://www.zomato.com/partner-with-us", source: "zomato.com", lead_quality: "GOOD", lead_score: 73, contact_email: "", contact_phone: "", lead_text: "Register as restaurant partner, start receiving orders." },
      { client_name: "Coach.me — Life/Business Coaching Clients", service_needed: "Teaching & Coaching", description: "Platform for coaches to find clients. Life coaching, business coaching, health coaching. Set your rate and availability.", industry: "Education", country: "Remote", city: "Worldwide", budget: "$50-200/session", source_url: "https://www.coach.me/become-a-coach", source: "coach.me", lead_quality: "GOOD", lead_score: 70, contact_email: "", contact_phone: "", lead_text: "Register as coach, clients book sessions through the platform." },
      { client_name: "Rover — Pet Sitting/Dog Walking (USA/UK/Canada)", service_needed: "Pet Services", description: "Register as a pet sitter or dog walker. Set your rates, get bookings from pet owners in your area.", industry: "Business Services", country: "USA", city: "Nationwide", budget: "$15-50/visit", source_url: "https://www.rover.com/become-a-sitter/", source: "rover.com", lead_quality: "GOOD", lead_score: 72, contact_email: "", contact_phone: "", lead_text: "Create a sitter profile with photos of your space." },
      { client_name: "TaskRabbit — Handyman & Service Jobs (USA/UK)", service_needed: "Freelance Services", description: "Get hired for furniture assembly, cleaning, moving, handyman work. Set your hourly rate. Immediate bookings.", industry: "Business Services", country: "USA", city: "Nationwide", budget: "$20-80/hour", source_url: "https://www.taskrabbit.com/become-a-tasker", source: "taskrabbit.com", lead_quality: "HOT", lead_score: 80, contact_email: "", contact_phone: "", lead_text: "Register, set availability, get same-day job requests." },
      { client_name: "We Work Remotely — Remote Developer/Designer Jobs", service_needed: "Web Development", description: "Premium remote job board. Companies post full-time and contract remote positions. Developer, designer, marketing roles.", industry: "Technology", country: "Remote", city: "Worldwide", budget: "$3000-$10000/mo", source_url: "https://weworkremotely.com/", source: "weworkremotely.com", lead_quality: "HOT", lead_score: 88, contact_email: "", contact_phone: "", lead_text: "Apply directly to companies hiring remote workers." },
      { client_name: "Catalant — Business Consulting Projects", service_needed: "Business Consulting", description: "Get matched with Fortune 500 companies needing consultants. Strategy, operations, marketing consulting projects.", industry: "Business Services", country: "Remote", city: "Worldwide", budget: "$5000-$50000", source_url: "https://www.catalant.com/experts", source: "catalant.com", lead_quality: "GOOD", lead_score: 75, contact_email: "", contact_phone: "", lead_text: "Register as an expert, get matched with enterprise projects." },
    ];
    let inserted = 0;
    for (const l of leads) {
      const existing = await db.select({ id: freelancerDashboardTable.id }).from(freelancerDashboardTable).where(eq(freelancerDashboardTable.client_name, l.client_name)).limit(1);
      if (existing.length > 0) continue;
      await db.insert(freelancerDashboardTable).values({
        ...l,
        verified_status: "verified",
        fetched_at: now,
      });
      inserted++;
    }
    res.json({ message: `Seeded ${inserted} high-quality leads (${leads.length - inserted} already existed)` });
  } catch (err) {
    console.error("Seed leads error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

router.post("/collector/run", requireAuth, attachRole, requireAdmin, async (req, res) => {
  try {
    console.log("[Admin] Manual collector run triggered");
    const result = await runCollector();
    res.json({ message: "Collector run complete", ...result });
  } catch (err) {
    console.error("[Admin] collector run error:", err);
    res.status(500).json({ error: "Collector run failed" });
  }
});

router.get("/stats", requireAuth, attachRole, requireAdmin, async (req, res) => {
  try {
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    const totalLeads = await db.select({ count: sql<number>`count(*)::int` })
      .from(freelancerDashboardTable);

    const todayLeads = await db.select({ count: sql<number>`count(*)::int` })
      .from(freelancerDashboardTable)
      .where(sql`${freelancerDashboardTable.created_at} >= ${today}`);

    const hotLeads = await db.select({ count: sql<number>`count(*)::int` })
      .from(freelancerDashboardTable)
      .where(eq(freelancerDashboardTable.lead_quality, "HOT"));

    res.json({
      total_leads: totalLeads[0]?.count || 0,
      today_leads: todayLeads[0]?.count || 0,
      hot_leads: hotLeads[0]?.count || 0,
    });
  } catch (err) {
    console.error("[Admin] stats error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

export default router;
