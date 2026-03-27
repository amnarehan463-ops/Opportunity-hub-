import { Router } from "express";
import { db, freelancerDashboardTable, freelancerSkillsTable, leadContactsTable, leadViewsTable } from "@workspace/db";
import { eq, and, gte, sql } from "drizzle-orm";
import { requireAuth } from "../lib/auth.js";
import { sbQuery } from "../lib/supabase.js";
import { freelancersTable } from "@workspace/db";
import { computeLeadScore } from "../services/lead-collector.js";

const router = Router();

const PLAN_DAILY_LIMITS: Record<string, number> = {
  basic: 15,
  premium: 50,
  gold: Infinity,
};

function applyFilters(leads: any[], query: any) {
  let result = leads;
  const { keyword, industry, country, city, quality } = query;
  if (keyword) {
    const searchWords = keyword.toLowerCase().trim().split(/\s+/).filter(Boolean);
    result = result.filter(l => {
      const allText = [
        l.client_name || "",
        l.service_needed || "",
        l.description || "",
        l.industry || "",
        l.lead_text || "",
      ].join(" ").toLowerCase();
      return searchWords.some((w: string) => allText.includes(w));
    });
  }
  if (industry && industry !== "All Industries") {
    result = result.filter(l => l.industry && l.industry.toLowerCase().includes(industry.toLowerCase()));
  }
  if (country && country !== "All Countries") {
    result = result.filter(l => l.country && l.country.toLowerCase().includes(country.toLowerCase()));
  }
  if (city) {
    result = result.filter(l => l.city && l.city.toLowerCase().includes(city.toLowerCase()));
  }
  if (quality) {
    const qualities = quality.split(",").map((q: string) => q.trim().toUpperCase());
    result = result.filter(l => qualities.includes((l.lead_quality || l.quality || "").toUpperCase()));
  }
  return result;
}

function calcMatchScore(lead: any, skillNames: string[]): number {
  if (!skillNames.length) return 50;
  const service = (lead.service_needed || "").toLowerCase();
  const desc = (lead.description || "").toLowerCase();
  const ind = (lead.industry || "").toLowerCase();
  const firstWord = service.split(" ")[0];
  let score = 0;
  for (const skill of skillNames) {
    const s = skill.toLowerCase();
    if (service.includes(s) || (firstWord.length >= 3 && s.includes(firstWord))) score += 45;
    else if (desc.includes(s)) score += 25;
    else if (ind.includes(s)) score += 15;
  }
  if ((lead.lead_quality || lead.quality || "") === "HOT") score += 10;
  else if ((lead.lead_quality || lead.quality || "") === "GOOD") score += 5;
  return Math.min(99, Math.max(10, score));
}

function getFreshnessDate() {
  const d = new Date();
  d.setDate(d.getDate() - 3);
  return d;
}

function applyFreshnessScoring(baseScore: number, createdAt: string | Date | null, fetchedAt: string | Date | null): { score: number; quality: string } {
  const refDate = fetchedAt || createdAt;
  if (!refDate) return { score: baseScore, quality: baseScore >= 80 ? "HOT" : baseScore >= 50 ? "GOOD" : "MEDIUM" };

  const ageMs = Date.now() - new Date(refDate).getTime();
  const ageHours = ageMs / (1000 * 60 * 60);

  let quality: string;
  let score: number;
  if (ageHours <= 2) {
    quality = "HOT";
    score = Math.max(baseScore, 85);
  } else if (ageHours <= 6) {
    quality = "GOOD";
    score = Math.min(Math.max(baseScore, 55), 79);
  } else {
    quality = "MEDIUM";
    score = Math.min(baseScore, 49);
  }

  score = Math.min(100, Math.max(10, score));
  return { score, quality };
}

function normalizeLead(lead: any, source: "local" | "supabase") {
  const raw = {
    description: lead.description || "",
    lead_text: lead.lead_text || "",
    service_needed: lead.service_needed || lead.service || "",
  };
  const { score: baseScore } = computeLeadScore(raw);
  const storedScore = lead.lead_score || baseScore;

  const createdAt = lead.created_at ? new Date(lead.created_at).toISOString() : new Date().toISOString();
  const fetchedAt = lead.fetched_at ? new Date(lead.fetched_at).toISOString() : null;

  const { score, quality } = applyFreshnessScoring(storedScore, createdAt, fetchedAt);

  return {
    id: lead.id,
    source,
    client_name: lead.client_name || lead.name || "Unknown",
    service_needed: raw.service_needed,
    lead_quality: quality,
    lead_score: score,
    description: lead.description || "",
    budget: lead.budget || null,
    country: lead.country || "",
    city: lead.city || "",
    industry: lead.industry || "",
    contact_email: lead.contact_email || lead.email || null,
    contact_phone: lead.contact_phone || lead.phone || null,
    source_url: lead.source_url || lead.url || null,
    lead_text: lead.lead_text || null,
    source_name: lead.source || source,
    verified_status: lead.verified_status || lead.status || "unverified",
    fetched_at: fetchedAt,
    created_at: createdAt,
  };
}

async function fetchSupabaseLeads(): Promise<any[]> {
  try {
    const sbLeads = await sbQuery("leads", q =>
      q.select("*").order("created_at", { ascending: false }).limit(200)
    );
    console.log(`[Leads] Fetched ${sbLeads.length} leads from Supabase`);
    return sbLeads.map(l => normalizeLead(l, "supabase"));
  } catch (err) {
    console.error("[Leads] Supabase fetch error:", err);
    return [];
  }
}

async function fetchLocalLeads(): Promise<any[]> {
  try {
    const thirtyDaysAgo = getFreshnessDate();
    const rows = await db.select()
      .from(freelancerDashboardTable)
      .where(gte(freelancerDashboardTable.fetched_at, thirtyDaysAgo));
    console.log(`[Leads] Fetched ${rows.length} leads from local DB`);
    return rows.map(l => normalizeLead(l, "local"));
  } catch (err) {
    console.error("[Leads] Local DB fetch error:", err);
    return [];
  }
}

function deduplicateLeads(leads: any[]): any[] {
  const seen = new Set<string>();
  return leads.filter(l => {
    const key = [
      (l.contact_email || "").toLowerCase().trim(),
      (l.contact_phone || "").toLowerCase().trim(),
      (l.client_name || "").toLowerCase().trim(),
    ].join("|");
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

async function getDailyViewCount(userId: number): Promise<number> {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  try {
    const result = await db.select({ count: sql<number>`count(DISTINCT lead_id)::int` })
      .from(leadViewsTable)
      .where(and(
        eq(leadViewsTable.freelancer_id, userId),
        gte(leadViewsTable.viewed_at, today)
      ));
    return result[0]?.count || 0;
  } catch {
    return 0;
  }
}

async function trackLeadViews(userId: number, leadIds: number[]) {
  if (leadIds.length === 0) return;
  try {
    const existing = await db.select({ lead_id: leadViewsTable.lead_id })
      .from(leadViewsTable)
      .where(and(
        eq(leadViewsTable.freelancer_id, userId),
        gte(leadViewsTable.viewed_at, (() => { const d = new Date(); d.setHours(0,0,0,0); return d; })())
      ));
    const existingSet = new Set(existing.map(e => e.lead_id));
    const newViews = leadIds.filter(id => !existingSet.has(id));

    if (newViews.length > 0) {
      await db.insert(leadViewsTable).values(
        newViews.map(lead_id => ({ freelancer_id: userId, lead_id }))
      );
    }
  } catch (err) {
    console.error("[Leads] Track views error:", err);
  }
}

router.get("/usage", requireAuth, async (req, res) => {
  try {
    const userId = (req as any).user.id;
    const [user] = await db.select({
      subscription_plan: freelancersTable.subscription_plan,
    }).from(freelancersTable).where(eq(freelancersTable.id, userId)).limit(1);

    const plan = user?.subscription_plan || "basic";
    const dailyLimit = PLAN_DAILY_LIMITS[plan] ?? 15;
    const viewedToday = await getDailyViewCount(userId);

    res.json({
      plan,
      daily_limit: isFinite(dailyLimit) ? dailyLimit : null,
      viewed_today: viewedToday,
      remaining: isFinite(dailyLimit) ? Math.max(0, dailyLimit - viewedToday) : null,
      limit_reached: isFinite(dailyLimit) && viewedToday >= dailyLimit,
    });
  } catch (err) {
    console.error("[Leads] usage error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

router.get("/", requireAuth, async (req, res) => {
  try {
    const userId = (req as any).user.id;

    const [user] = await db.select({
      subscription_plan: freelancersTable.subscription_plan,
    }).from(freelancersTable).where(eq(freelancersTable.id, userId)).limit(1);

    const plan = user?.subscription_plan || "basic";
    const dailyLimit = PLAN_DAILY_LIMITS[plan] ?? 15;
    const viewedToday = await getDailyViewCount(userId);

    if (isFinite(dailyLimit) && viewedToday >= dailyLimit) {
      res.json({
        leads: [],
        usage: { plan, daily_limit: dailyLimit, viewed_today: viewedToday, remaining: 0, limit_reached: true },
        message: "Daily lead limit reached. Upgrade your plan."
      });
      return;
    }

    const skills = await db.select().from(freelancerSkillsTable)
      .where(eq(freelancerSkillsTable.freelancer_id, userId));
    const skillNames = skills.map(s => s.skill_name.toLowerCase());

    const [sbLeads, localLeads] = await Promise.all([fetchSupabaseLeads(), fetchLocalLeads()]);
    const allLeads = deduplicateLeads([...sbLeads, ...localLeads]);

    const contacts = await db.select().from(leadContactsTable)
      .where(eq(leadContactsTable.freelancer_id, userId));
    const contactMap = Object.fromEntries(contacts.map(c => [`${c.lead_id}`, c.status]));

    let filtered = allLeads;
    if (skillNames.length > 0) {
      filtered = allLeads.filter(lead => {
        const service = (lead.service_needed || "").toLowerCase();
        const desc = (lead.description || "").toLowerCase();
        const ind = (lead.industry || "").toLowerCase();
        const firstWord = service.split(" ")[0];
        return skillNames.some(skill =>
          service.includes(skill) || desc.includes(skill) || ind.includes(skill) || (firstWord.length >= 3 && skill.includes(firstWord))
        );
      });
    }

    filtered = applyFilters(filtered, req.query);
    let withScores = filtered
      .map(l => ({ ...l, match_score: calcMatchScore(l, skillNames), contact_status: contactMap[`${l.id}`] || null }))
      .sort((a, b) => {
        const qualityOrder: Record<string, number> = { HOT: 3, GOOD: 2, MEDIUM: 1 };
        const qa = qualityOrder[a.lead_quality] || 0;
        const qb = qualityOrder[b.lead_quality] || 0;
        if (qa !== qb) return qb - qa;
        return (b.lead_score || 0) - (a.lead_score || 0);
      });

    const remaining = isFinite(dailyLimit) ? dailyLimit - viewedToday : Infinity;
    if (isFinite(remaining)) {
      withScores = withScores.slice(0, remaining);
    }

    const leadIdsToTrack = withScores
      .filter(l => l.source === "local" && typeof l.id === "number")
      .map(l => l.id);
    await trackLeadViews(userId, leadIdsToTrack);
    const newViewCount = withScores.length;

    res.json({
      leads: withScores,
      usage: {
        plan,
        daily_limit: isFinite(dailyLimit) ? dailyLimit : null,
        viewed_today: viewedToday + newViewCount,
        remaining: isFinite(remaining) ? Math.max(0, remaining - newViewCount) : null,
        limit_reached: false,
      },
    });
  } catch (err) {
    console.error("[Leads] GET / error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

router.get("/all", requireAuth, async (req, res) => {
  try {
    const userId = (req as any).user.id;

    const [user] = await db.select({
      subscription_plan: freelancersTable.subscription_plan,
    }).from(freelancersTable).where(eq(freelancersTable.id, userId)).limit(1);

    const plan = user?.subscription_plan || "basic";
    const dailyLimit = PLAN_DAILY_LIMITS[plan] ?? 15;
    const viewedToday = await getDailyViewCount(userId);

    if (isFinite(dailyLimit) && viewedToday >= dailyLimit) {
      res.json({
        leads: [],
        usage: { plan, daily_limit: dailyLimit, viewed_today: viewedToday, remaining: 0, limit_reached: true },
        message: "Daily lead limit reached. Upgrade your plan."
      });
      return;
    }

    const skills = await db.select().from(freelancerSkillsTable)
      .where(eq(freelancerSkillsTable.freelancer_id, userId));
    const skillNames = skills.map(s => s.skill_name.toLowerCase());

    const [sbLeads, localLeads] = await Promise.all([fetchSupabaseLeads(), fetchLocalLeads()]);
    const allLeads = deduplicateLeads([...sbLeads, ...localLeads]);

    const contacts = await db.select().from(leadContactsTable)
      .where(eq(leadContactsTable.freelancer_id, userId));
    const contactMap = Object.fromEntries(contacts.map(c => [`${c.lead_id}`, c.status]));

    const filtered = applyFilters(allLeads, req.query);
    let withScores = filtered
      .map(l => ({ ...l, match_score: calcMatchScore(l, skillNames), contact_status: contactMap[`${l.id}`] || null }))
      .sort((a, b) => {
        const qualityOrder: Record<string, number> = { HOT: 3, GOOD: 2, MEDIUM: 1 };
        const qa = qualityOrder[a.lead_quality] || 0;
        const qb = qualityOrder[b.lead_quality] || 0;
        if (qa !== qb) return qb - qa;
        return (b.lead_score || 0) - (a.lead_score || 0);
      });

    const remaining = isFinite(dailyLimit) ? dailyLimit - viewedToday : Infinity;
    if (isFinite(remaining)) {
      withScores = withScores.slice(0, remaining);
    }

    const leadIdsToTrack = withScores
      .filter(l => l.source === "local" && typeof l.id === "number")
      .map(l => l.id);
    await trackLeadViews(userId, leadIdsToTrack);
    const newViewCount = withScores.length;

    res.json({
      leads: withScores,
      usage: {
        plan,
        daily_limit: isFinite(dailyLimit) ? dailyLimit : null,
        viewed_today: viewedToday + newViewCount,
        remaining: isFinite(remaining) ? Math.max(0, remaining - newViewCount) : null,
        limit_reached: false,
      },
    });
  } catch (err) {
    console.error("[Leads] GET /all error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

router.get("/today-count", requireAuth, async (req, res) => {
  try {
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    let localCount = 0;
    try {
      const result = await db.select({ count: sql<number>`count(*)::int` })
        .from(freelancerDashboardTable)
        .where(gte(freelancerDashboardTable.created_at, today));
      localCount = result[0]?.count || 0;
    } catch (e) {
      console.error("[Leads] today-count local error:", e);
    }

    let sbCount = 0;
    try {
      const sbLeads = await sbQuery("leads", q =>
        q.select("id").gte("created_at", today.toISOString())
      );
      sbCount = sbLeads.length;
    } catch (e) {
      console.error("[Leads] today-count supabase error:", e);
    }

    res.json({ count: localCount + sbCount });
  } catch (err) {
    res.status(500).json({ error: "Internal server error" });
  }
});

const SUGGESTION_PLATFORMS: Record<string, Array<{ name: string; url: string; desc: string }>> = {
  "Web Development": [
    { name: "Toptal", url: "https://www.toptal.com/developers", desc: "Top 3% developers marketplace" },
    { name: "We Work Remotely", url: "https://weworkremotely.com/categories/remote-programming-jobs", desc: "Remote developer jobs" },
    { name: "r/forhire", url: "https://www.reddit.com/r/forhire/", desc: "Reddit hiring community" },
    { name: "AngelList", url: "https://wellfound.com/jobs", desc: "Startup jobs board" },
    { name: "Stack Overflow Jobs", url: "https://stackoverflow.com/jobs", desc: "Developer job board" },
  ],
  "Graphic Design": [
    { name: "Dribbble Jobs", url: "https://dribbble.com/jobs", desc: "Design-focused job board" },
    { name: "Behance Jobs", url: "https://www.behance.net/joblist", desc: "Creative job listings" },
    { name: "99designs", url: "https://99designs.com", desc: "Design contest platform" },
    { name: "DesignCrowd", url: "https://www.designcrowd.com", desc: "Freelance design marketplace" },
  ],
  "Content Writing": [
    { name: "ProBlogger", url: "https://problogger.com/jobs/", desc: "Blogging & writing jobs" },
    { name: "Contently", url: "https://contently.com", desc: "Content marketing platform" },
    { name: "r/HireaWriter", url: "https://www.reddit.com/r/HireaWriter/", desc: "Reddit writer hiring" },
  ],
  "Digital Marketing": [
    { name: "GrowthHackers", url: "https://growthhackers.com/jobs", desc: "Marketing growth jobs" },
    { name: "MarketingHire", url: "https://www.marketinghire.com", desc: "Marketing job board" },
    { name: "HubSpot Jobs", url: "https://www.hubspot.com/jobs", desc: "Inbound marketing careers" },
  ],
  "Teaching & Coaching": [
    { name: "Preply", url: "https://preply.com/en/teach", desc: "Online tutoring platform" },
    { name: "iTalki", url: "https://www.italki.com/teacher/apply", desc: "Language teaching platform" },
    { name: "Wyzant", url: "https://www.wyzant.com/tutorjobs", desc: "Tutoring marketplace" },
    { name: "TutorMe", url: "https://tutorme.com/apply/", desc: "Online tutoring jobs" },
    { name: "Varsity Tutors", url: "https://www.varsitytutors.com/tutor-application", desc: "Academic tutoring" },
  ],
  "Food Business": [
    { name: "CaterCow", url: "https://www.catercow.com", desc: "Catering marketplace" },
    { name: "Google Maps (Catering)", url: "https://www.google.com/maps/search/catering+service", desc: "Local catering listings" },
    { name: "Thumbtack", url: "https://www.thumbtack.com/k/personal-chefs/", desc: "Local service marketplace" },
    { name: "TaskRabbit", url: "https://www.taskrabbit.com", desc: "Local services platform" },
  ],
  "Mobile App Development": [
    { name: "Toptal Mobile", url: "https://www.toptal.com/mobile", desc: "Top mobile developers" },
    { name: "Gun.io", url: "https://gun.io", desc: "Vetted freelance developers" },
    { name: "Arc.dev", url: "https://arc.dev/remote-jobs", desc: "Remote developer jobs" },
  ],
  "Video Editing": [
    { name: "Mandy.com", url: "https://www.mandy.com", desc: "Film & video production jobs" },
    { name: "ProductionHub", url: "https://www.productionhub.com/jobs", desc: "Media production jobs" },
    { name: "Vidpros", url: "https://vidpros.com", desc: "Video editing services" },
  ],
  "Social Media Management": [
    { name: "FlexJobs", url: "https://www.flexjobs.com/remote-jobs/social-media", desc: "Remote social media jobs" },
    { name: "SolidGigs", url: "https://solidgigs.com", desc: "Freelance gig curation" },
    { name: "PeoplePerHour", url: "https://www.peopleperhour.com", desc: "Freelance marketplace" },
  ],
  "Virtual Assistant": [
    { name: "Belay", url: "https://belaysolutions.com/assistants/", desc: "Virtual assistant company" },
    { name: "Time Etc", url: "https://web.timeetc.com/apply", desc: "VA marketplace" },
    { name: "Boldly", url: "https://boldly.com/apply/", desc: "Premium remote staffing" },
  ],
  "SaaS": [
    { name: "Reddit r/freelance", url: "https://www.reddit.com/r/freelance/", desc: "Freelancers looking for tools & clients" },
    { name: "Reddit r/forhire", url: "https://www.reddit.com/r/forhire/", desc: "People offering services — your potential customers" },
    { name: "LinkedIn Sales Navigator", url: "https://www.linkedin.com/sales/", desc: "Find and reach freelancers & coaches" },
    { name: "Facebook Groups", url: "https://www.facebook.com/groups/", desc: "Freelancer & teacher communities" },
    { name: "Product Hunt", url: "https://www.producthunt.com", desc: "Launch your SaaS to early adopters" },
    { name: "AppSumo", url: "https://appsumo.com/partners/", desc: "Lifetime deals marketplace for SaaS" },
    { name: "IndieHackers", url: "https://www.indiehackers.com", desc: "Community of SaaS builders & buyers" },
  ],
  "SaaS Prospect": [
    { name: "Reddit r/freelance", url: "https://www.reddit.com/r/freelance/", desc: "Freelancers struggling to find clients" },
    { name: "Reddit r/forhire", url: "https://www.reddit.com/r/forhire/new/", desc: "People actively seeking work" },
    { name: "LinkedIn", url: "https://www.linkedin.com/search/results/people/?keywords=freelancer%20open%20to%20work", desc: "Freelancers open to work" },
    { name: "Twitter/X Search", url: "https://x.com/search?q=freelancer%20need%20clients&f=live", desc: "Real-time freelancer conversations" },
  ],
};

const DEFAULT_SUGGESTIONS = [
  { name: "LinkedIn", url: "https://www.linkedin.com/jobs/", desc: "Professional networking & jobs" },
  { name: "Reddit r/forhire", url: "https://www.reddit.com/r/forhire/", desc: "Reddit hiring community" },
  { name: "Craigslist Gigs", url: "https://www.craigslist.org/about/sites", desc: "Local classified ads" },
  { name: "Indeed", url: "https://www.indeed.com", desc: "General job board" },
  { name: "Google Maps", url: "https://www.google.com/maps", desc: "Find local businesses" },
  { name: "Facebook Groups", url: "https://www.facebook.com/groups/", desc: "Community job groups" },
];

router.get("/suggestions", requireAuth, async (req, res) => {
  try {
    const userId = (req as any).user.id;
    const { skill, country, city } = req.query as { skill?: string; country?: string; city?: string };

    const skills = await db.select().from(freelancerSkillsTable)
      .where(eq(freelancerSkillsTable.freelancer_id, userId));
    const skillNames = skills.map(s => s.skill_name);
    const searchSkill = skill || skillNames[0] || "";

    const location = [city, country].filter(Boolean).join(", ");
    const suggestions: Array<{ name: string; url: string; desc: string; type: string }> = [];

    for (const [category, platforms] of Object.entries(SUGGESTION_PLATFORMS)) {
      if (!searchSkill || category.toLowerCase().includes(searchSkill.toLowerCase()) || searchSkill.toLowerCase().includes(category.split(" ")[0].toLowerCase())) {
        platforms.forEach(p => suggestions.push({ ...p, type: "platform" }));
      }
    }

    if (suggestions.length === 0) {
      DEFAULT_SUGGESTIONS.forEach(p => suggestions.push({ ...p, type: "platform" }));
    }

    const searchSuggestions = [];
    if (searchSkill) {
      searchSuggestions.push({
        name: `LinkedIn: "${searchSkill}" jobs${location ? ` in ${location}` : ""}`,
        url: `https://www.linkedin.com/jobs/search/?keywords=${encodeURIComponent(searchSkill)}${location ? `&location=${encodeURIComponent(location)}` : ""}`,
        desc: "Search LinkedIn for matching opportunities",
        type: "search",
      });
      searchSuggestions.push({
        name: `Indeed: "${searchSkill}"${location ? ` in ${location}` : ""}`,
        url: `https://www.indeed.com/jobs?q=${encodeURIComponent(searchSkill)}${location ? `&l=${encodeURIComponent(location)}` : ""}`,
        desc: "Search Indeed for job listings",
        type: "search",
      });
      searchSuggestions.push({
        name: `Google: "${searchSkill} hiring"${location ? ` ${location}` : ""}`,
        url: `https://www.google.com/search?q=${encodeURIComponent(`${searchSkill} hiring freelance${location ? ` ${location}` : ""}`)}`,
        desc: "Search Google for opportunities",
        type: "search",
      });
      if (location) {
        searchSuggestions.push({
          name: `Google Maps: "${searchSkill}" near ${location}`,
          url: `https://www.google.com/maps/search/${encodeURIComponent(`${searchSkill} ${location}`)}`,
          desc: "Find local businesses needing your services",
          type: "search",
        });
      }
    }

    res.json({
      suggestions: [...searchSuggestions, ...suggestions.slice(0, 8)],
      skill: searchSkill,
      location: location || null,
      message: searchSkill
        ? `No exact leads found for "${searchSkill}"${location ? ` in ${location}` : ""}. Here are places where opportunities may be available:`
        : "Here are platforms where you can find opportunities:",
    });
  } catch (err) {
    console.error("[Leads] suggestions error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

router.post("/:id/contact", requireAuth, async (req, res) => {
  try {
    const userId = (req as any).user.id;
    const leadId = parseInt(String(req.params.id));
    const { status } = req.body;
    const validStatuses = ["contacted", "replied", "won", "not_interested", "none"];
    if (!validStatuses.includes(status)) {
      res.status(400).json({ error: "Invalid status" });
      return;
    }
    if (status === "none") {
      await db.delete(leadContactsTable)
        .where(and(eq(leadContactsTable.freelancer_id, userId), eq(leadContactsTable.lead_id, leadId)));
    } else {
      const existing = await db.select().from(leadContactsTable)
        .where(and(eq(leadContactsTable.freelancer_id, userId), eq(leadContactsTable.lead_id, leadId)))
        .limit(1);
      if (existing.length > 0) {
        await db.update(leadContactsTable)
          .set({ status, updated_at: new Date() })
          .where(and(eq(leadContactsTable.freelancer_id, userId), eq(leadContactsTable.lead_id, leadId)));
      } else {
        await db.insert(leadContactsTable).values({ freelancer_id: userId, lead_id: leadId, status });
      }
    }
    res.json({ success: true });
  } catch (err) {
    console.error("[Leads] contact status error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

export default router;
