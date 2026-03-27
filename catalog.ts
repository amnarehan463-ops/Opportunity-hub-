import { Router } from "express";
import { supabase, sbQuery } from "../lib/supabase.js";

const router = Router();

router.get("/skills", async (req, res) => {
  try {
    const skills = await sbQuery("skills", q => q.select("*").order("name", { ascending: true }));
    console.log(`[Catalog] Fetched ${skills.length} skills from Supabase`);
    res.json(skills);
  } catch (err) {
    console.error("[Catalog] skills error:", err);
    res.status(500).json({ error: "Failed to fetch skills catalog" });
  }
});

router.get("/plans", async (req, res) => {
  try {
    const plans = await sbQuery("plans", q => q.select("*").order("price", { ascending: true }));
    console.log(`[Catalog] Fetched ${plans.length} plans from Supabase`);
    res.json(plans);
  } catch (err) {
    console.error("[Catalog] plans error:", err);
    res.status(500).json({ error: "Failed to fetch plans" });
  }
});


export default router;
