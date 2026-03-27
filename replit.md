# Workspace

## Overview

pnpm workspace monorepo using TypeScript. Each package manages its own dependencies.

## Stack

- **Monorepo tool**: pnpm workspaces
- **Node.js version**: 24
- **Package manager**: pnpm
- **TypeScript version**: 5.9
- **API framework**: Express 5
- **Database**: PostgreSQL + Drizzle ORM
- **Validation**: Zod (`zod/v4`), `drizzle-zod`
- **API codegen**: Orval (from OpenAPI spec)
- **Build**: esbuild (CJS bundle)
- **Auth**: JWT (bcryptjs + jsonwebtoken), stored in localStorage

## Project: Opportunity Hub

A SaaS lead discovery platform for professionals (freelancers, teachers/coaches, food businesses incl. HomeChef) with:
- JWT-based authentication (register/login/logout) with phone uniqueness check (DB-level unique constraint)
- **Invite Link System**: Admin generates personal invite links per client email → client registers via locked-email page → 14-day free trial auto-assigned → one person per subscription enforced (email + phone unique)
  - Invite tokens table: `invite_tokens` (token, email, phone, plan, trial_days, used)
  - Admin endpoints: `POST /api/admin/invite`, `GET /api/admin/invites`, `DELETE /api/admin/invites/:id`
  - Public endpoints: `GET /api/auth/invite/:token` (verify), `POST /api/auth/invite/:token/register`
  - Frontend: `/invite/:token` route with `InviteRegister.tsx` page
  - Admin UI: "Invite Links" tab in admin panel with form to create invites and list of all invites
- Lead cards with contact buttons (Email, Call, Copy)
- Skill-based lead matching supporting freelancers, teachers/coaches, food businesses, HomeChef
- Advanced search + filters: keyword, industry, country (Pakistan/Qatar/Saudi Arabia/UAE/Canada/Australia/UK/USA/South Africa/Nigeria), city, lead quality (HOT/GOOD/MEDIUM)
- Subscription status handling — trial/active/inactive with banners and expiry reminders (7-day, 24-hour)
- Subscription plan limits (Basic: 2 skills/15 leads, Premium: 5 skills/50 leads, Exclusive: unlimited)
- Referral program with shareable links (copy, WhatsApp, email, X) — link format: https://opportunity-hub.replit.app/register?ref=CODE
- Reseller program (30% commission, 100% bonus every 6th sale, Gold bonus: 2 Gold sales → +100% commission)
- Admin panel with user management, role assignment (user/reseller/admin), reseller commission tracking
- Policy pages: Privacy Policy, Terms of Service, Subscription Policy, Contact
- Mobile-friendly card layout with React + Vite frontend
- "Earn First, Pay After." motto displayed throughout

## Structure

```text
artifacts-monorepo/
├── artifacts/              # Deployable applications
│   ├── api-server/         # Express API server (port 8080, path /api)
│   └── opportunity-hub/    # React + Vite SaaS dashboard (port 5000, path /)
├── lib/                    # Shared libraries
│   ├── api-spec/           # OpenAPI spec + Orval codegen config
│   ├── api-client-react/   # Generated React Query hooks
│   ├── api-zod/            # Generated Zod schemas from OpenAPI
│   └── db/                 # Drizzle ORM schema + DB connection
```

## Database Tables

- `freelancers` — User accounts: email, phone, password_hash, name, role (user/reseller/admin), subscription_status, subscription_plan, subscription_expires_at, referral_code, referred_by
- `freelancer_dashboard` — Lead records: client_name, service_needed, lead_quality (HOT|GOOD|MEDIUM), lead_score (int), lead_text, source, description, budget, country, city, industry, contact_email, contact_phone
- `freelancer_skills` — Skills per freelancer for lead matching
- `lead_views` — Daily lead view tracking: freelancer_id, lead_id, viewed_at (for daily limit enforcement)

## API Routes

- `POST /api/auth/register` — Register (email + optional phone uniqueness, auto-generates referral code)
- `POST /api/auth/login` — Login
- `POST /api/auth/logout` — Logout
- `GET /api/auth/me` — Get current user (returns role, subscription_plan, subscription_expires_at, referral_code)
- `GET /api/leads` — Skill-matched leads (filters: keyword, industry, country, city, quality) — enforces daily view limits
- `GET /api/leads/all` — All leads (same filters) — enforces daily view limits
- `GET /api/leads/usage` — Get daily usage stats (plan, daily_limit, viewed_today, remaining, limit_reached)
- `GET /api/skills` — Get user skills
- `POST /api/skills` — Add skill
- `DELETE /api/skills/:id` — Remove skill
- `GET /api/admin/users` — Admin: all users with roles/subscription status
- `GET /api/admin/resellers` — Admin: reseller commission summary
- `PATCH /api/admin/users/:id/role` — Admin: change user role
- `PATCH /api/admin/users/:id/subscription` — Admin: update subscription (plan, status, duration_days → auto-sets expiry)
- `POST /api/admin/collector/run` — Admin: manually trigger lead collector
- `POST /api/admin/seed-leads` — Admin: seed 30 curated high-quality leads (skips existing ones)

## Lead Collector

Automated lead collection service (`artifacts/api-server/src/services/lead-collector.ts`):
- Runs on schedule: every 3 hours (first run 10s after server boot)
- **Free sources**: Reddit JSON feeds (r/forhire, r/freelance, r/hiring) — no API key needed
- **Paid sources**: Serper.dev search API (optional `SERPER_API_KEY` env var) for richer results
- 3-day freshness: only shows leads from the last 3 days (stale leads hidden)
- **Time-based freshness scoring** (applied when leads are served, not stored):
  - ≤2 hours old → HOT (score boosted to 85+)
  - 2–6 hours old → GOOD (score boosted to 55+)
  - >6 hours old → MEDIUM (score capped at 49)
- Base scoring: demand signals ("hiring", "urgently", "asap"), contact info, budget presence
- URL sanitization: only http/https URLs stored and rendered
- **Country detection**: Extracts country/city from post text (Pakistan, UAE, Saudi Arabia, Qatar, UK, USA, Canada, Australia, Nigeria, South Africa, India; defaults to "Remote")
- **Budget extraction**: Detects dollar amounts from post text (e.g. "$500/hr", "$2,000-$3,000/project")
- Deduplicates by source_url, contact_email, contact_phone, or client_name (with normalization)
- Admin delete cascades through lead_views and lead_contacts in a transaction

## Smart Suggestions

When no leads match a user's search/filters, the API returns personalized suggestions (`GET /api/leads/suggestions`):
- When no leads match a search, shows **fallback leads** (other available leads from the database) instead of redirecting to external platforms
- Users always see real leads — never external links to Facebook/LinkedIn/etc.
- Categories: Web Dev, Graphic Design, Content Writing, Digital Marketing, Teaching & Coaching, Food Business, Mobile App Dev, Video Editing, Social Media, Virtual Assistant, SaaS Sales, SaaS Prospect

## SaaS Sales / Self-Prospecting

The platform can find potential customers for itself. When "SaaS Sales" or "SaaS Prospect" is set as a skill:
- The collector searches for freelancers, teachers, coaches, food businesses who are **struggling to find clients** — these are ideal customers for Opportunity Hub
- Search queries target phrases like "looking for clients", "need more clients", "how to find clients", "open to work"
- Leads tagged with industry "SaaS Prospect" can be filtered on the dashboard
- Outreach message: "I built Opportunity Hub to find leads — I found you using it, which proves it works"

## Frontend Pages

- `/dashboard` — Lead search + filters + subscription status
- `/skills` — Skills management with plan limit enforcement
- `/reseller` — Reseller program info + apply button
- `/referral` — Referral program with copy/share link (WhatsApp, email, X)
- `/admin` — Admin panel (admin role required) — users, resellers, commission tracking
- `/privacy` — Privacy Policy
- `/terms` — Terms of Service
- `/subscription-policy` — Subscription Policy
- `/contact` — Contact page

## Subscription System

- `trial` → full access + "Free Trial Active" banner
- `active` → full access + expiry reminders (7-day amber, 24-hour red, expired)
- `inactive` → dashboard blocked + "Subscription inactive. Please upgrade to continue."

## Plan Limits

| Plan | Skills | Leads/day |
|------|--------|-----------|
| Basic | 2 | 15 |
| Premium | 5 | 50 |
| Gold | Unlimited | Unlimited |

## Roles

- `user` — standard access
- `reseller` — appears in admin reseller tracking
- `admin` — full admin panel access, can change roles

## Deployment

The app is deployed as a single Express server (`artifacts/api-server/dist/index.cjs`) that:
1. Serves the API under `/api/*`
2. Serves the pre-built Vite frontend (`artifacts/opportunity-hub/dist/public/`) for all other routes

**Static file serving**: Uses `fs.readFile` + `import.meta.url` for path resolution (works in both ESM dev via tsx and CJS production bundle via esbuild). Path: `__currentDir/../../../artifacts/opportunity-hub/dist/public`.

**Dist files are committed to git** (via `.gitignore` negation rules) so the deployment runs the pre-built bundle without needing a separate build step.

**Deployment config** (`.replit`):
- `build`: `npm install`
- `run`: `npm run dev` → `node artifacts/api-server/dist/index.cjs`
- Target: `autoscale`

## Root Scripts

- `pnpm run build` — typecheck + build all packages
- `pnpm run typecheck` — tsc build check
- `pnpm --filter @workspace/api-spec run codegen` — regenerate API client
- `pnpm --filter @workspace/db run push` — push DB schema changes
- `pnpm --filter @workspace/api-server run build` — rebuild API production bundle
- `pnpm --filter @workspace/opportunity-hub run build` — rebuild frontend
