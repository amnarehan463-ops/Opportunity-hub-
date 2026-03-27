import { Router } from "express";
import { db, freelancerSkillsTable } from "@workspace/db";
import { eq, and } from "drizzle-orm";
import { requireAuth } from "../lib/auth.js";

const router = Router();

router.get("/", requireAuth, async (req, res) => {
  try {
    const userId = (req as any).user.id;
    const skills = await db
      .select()
      .from(freelancerSkillsTable)
      .where(eq(freelancerSkillsTable.freelancer_id, userId));

    res.json(skills.map(s => ({
      ...s,
      created_at: s.created_at.toISOString(),
    })));
  } catch (err) {
    console.error("GetSkills error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

router.post("/", requireAuth, async (req, res) => {
  try {
    const userId = (req as any).user.id;
    const { skill_name } = req.body;

    if (!skill_name) {
      res.status(400).json({ error: "skill_name is required" });
      return;
    }

    const [skill] = await db
      .insert(freelancerSkillsTable)
      .values({ freelancer_id: userId, skill_name })
      .returning();

    res.status(201).json({
      ...skill,
      created_at: skill.created_at.toISOString(),
    });
  } catch (err) {
    console.error("AddSkill error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

router.delete("/:id", requireAuth, async (req, res) => {
  try {
    const userId = (req as any).user.id;
    const skillId = parseInt(String(req.params.id));

    await db
      .delete(freelancerSkillsTable)
      .where(and(
        eq(freelancerSkillsTable.id, skillId),
        eq(freelancerSkillsTable.freelancer_id, userId)
      ));

    res.json({ message: "Skill removed" });
  } catch (err) {
    console.error("DeleteSkill error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

export default router;
