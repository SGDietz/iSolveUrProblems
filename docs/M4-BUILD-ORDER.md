# Milestone 4 — Build Order

> Companion to [ROADMAP.md](ROADMAP.md). Scope-only. No timelines.
> Goal of M4: **6 stops being the homeowner's assistant only. 6 becomes the contractor's operating system.** Contractors pay monthly subscriptions because the platform changes their working life. Recurring homeowner jobs run unattended on autopilot.
> Source vision: `20260326-iSolveUrProblems-LASTB4MOVE2DROPBOX.docx`
> Companion docs: [M3-BUILD-ORDER.md](M3-BUILD-ORDER.md), [M3-DELIVERY.md](M3-DELIVERY.md), [M2-DELIVERY.md](M2-DELIVERY.md)

> Status: **DRAFT — for Bert's review.** Built on top of an M3 codebase that's code-complete and merged. M4 introduces the contractor-side surface (which M1–M3 don't have) plus the autopilot job-execution layer.

---

## TL;DR

M3 finished what 6 does FOR the homeowner. M4 builds what 6 does FOR the contractor — and what 6 does autonomously when nobody's in the loop.

Three structural shifts in this milestone:

1. **Contractor portal lands.** Today contractors exist only as DB rows seeded by an admin. M4 introduces self-signup, dashboard, job inbox, photo/video log surface, subscription billing. This is **prerequisite work** without which most of M4.1–M4.9 can't happen.
2. **Stripe Billing joins Stripe Connect.** M2.5 added Connect (payouts to contractors). M4.1 adds Billing (monthly subscriptions FROM contractors). Different product, different webhooks, different surface.
3. **The job lifecycle gains an autopilot.** M3 makes a single hire-job traceable end-to-end. M4 makes recurring jobs run themselves — every Tuesday mowing, monthly gutter check, snow days as they happen — with 6 dispatching, confirming, photographing, and reporting without prompting.

**M4 exit gate:** a homeowner asks 6 *"keep my lawn mowed every Tuesday from May through October"* → 6 picks a contractor → contractor accepts subscription job in their portal → every week the appointment fires, 6 confirms the contractor is showing up, the worker takes the required photo on arrival + completion, and 6 emails the homeowner the photo log — for the whole season, with zero homeowner re-engagement.

---

## Audience

- **The dev team** — uses the per-feature sub-task lists, dependency graph, and the M4.0 contractor-portal foundation to plan the build.
- **SG Dietz** — uses "Decisions Required" and "What SG Dietz Must Provide" to unblock the build. Subscription tiers and contractor ToS are the new long-lead items.

Every M4.1–M4.9 entry is grounded in a paragraph of the source vision doc. **M4.0 is foundation work** — like M3.0 it's not in the vision doc directly, but every M4 feature depends on contractors being able to log into their own surface.

---

## Why M4

After M3, the codebase can do this:

- A homeowner asks 6 to find a plumber → 6 ranks, recommends, calls, books, contracts, schedules, mediates disputes. Voice-driven, drawer-rendered, end-to-end.

But the contractor still has no surface. They get an SMS saying "you won the job", they get a Stripe Connect payout, they get a contract emailed to them — all reactive. They can't:

- See their job pipeline (active / accepted / completed)
- Subscribe to a paid tier of 6 features
- Decline a referral
- Find sub-contractors when they're double-booked
- Get a pre-departure tool/material checklist
- Log work photos against an active job
- Take recurring weekly/monthly jobs

M4 is the milestone where 6 becomes a two-sided product. The homeowner side stays as M3 shipped it; the contractor side gets built.

**Why this matters commercially:** the platform's recurring revenue lives in M4. M2.5's 5% per-job fee on Stripe-net is rounding error after card processing. M4.1's subscriptions are the actual business model.

---

## Phase structure

Sequencing reflects what unblocks what.

### Phase 1 — Contractor portal foundation

Everything else in M4 depends on contractors having a logged-in surface. Build this first.

| # | Feature | Vision anchor | Depends on |
|---|---|---|---|
| **M4.0a** | Contractor data sourcing — license-board adapter (CSLB first; TX/FL/NY follow) | Vision ¶9 *"scraping the internet"* | M1.6 source-adapter abstraction (already in) |
| **M4.0b** | SerpAPI adapter wired into the source registry | Vision ¶9 | M1.6, legal sign-off |
| **M4.0c** | Contractor self-signup + profile claim flow | (not in vision; operational requirement) | M4.0a or M4.0b — claim works against existing rows |
| **M4.0d** | Contractor dashboard shell + job inbox | (not in vision; operational requirement) | M4.0c |

### Phase 2 — Subscription revenue + per-job automation

After Phase 1 ships, these run in any order.

| # | Feature | Vision anchor | Depends on |
|---|---|---|---|
| M4.1 | Tiered contractor subscriptions (Stripe Billing) | Vision ¶24-25 | M4.0d |
| M4.3 | Tool/material checklist agent (per-job, pre-departure) | Vision ¶24 | M4.0d, M3.4 appointments |
| M4.5 | Daily photo/video job logging | Vision ¶31 | M4.0d, M3.4 |
| M4.7 | Recurring / autopilot job scheduler | Vision ¶33 | M3.4 + M3.5 cron, M4.0d |
| M4.8 | Positive-coaching nudges for workers & contractors | Vision ¶28 | M1.7 notification fabric, M4.0d |

### Phase 3 — Multi-party orchestration

These touch both sides and have the highest moving-parts complexity.

| # | Feature | Vision anchor | Depends on |
|---|---|---|---|
| M4.2 | Crew & laborer marketplace inside contractor's 6 chat | Vision ¶24 | M4.0d, M3.0e orchestrator |
| M4.4 | Backup/replacement dispatcher (no-show recovery) | Vision ¶33 | M3.4 + M3.5 + M4.0d |
| M4.9 | In-person go-between mode (6 mediates on one or both phones) | Vision ¶15 | M3.1 calls + M4.0d |

### Phase 4 — Vision / intelligence

Highest schedule risk. Time-boxed spike first; if the spike clears, ship; if not, carry to M5.

| # | Feature | Vision anchor | Depends on |
|---|---|---|---|
| M4.6 | Worker-in-the-loop computer vision (weed/flower, visual diff between visits) | Vision ¶27 | M4.5 photo logging |

---

## Per-feature breakdown

### M4.0 — Contractor portal foundation

Not in the vision doc but the lowest-level prerequisite for everything else in M4. Same role M3.0 played for M3.

#### M4.0a — License-board contractor adapter

**Why:** Vision ¶9 anchors "the iSolve backend agents begin scraping the internet". M1.6 set up the source-adapter abstraction with a mock seeder and a SerpAPI slot; M4.0a is the first real adapter — pulling licensed-contractor records from state license boards.

**Why license boards first (vs SerpAPI first):**
- Free public records, storable forever — no ToS land mines
- Built-in verification — every row has a state-issued license number
- Doubles as the "Ai Certified — License Verified" trust badge (M4.3)
- Stripe Connect needs KYC'd contractors; a verified license number is a stronger KYC signal than a Google Maps listing

**Sub-tasks:**
1. New adapter `src/lib/contractors/sources/licenseBoard.ts` implementing the existing source-adapter interface
2. CSLB (California Contractors State License Board) as the first source — ~290k active licenses, public DPL search endpoint
3. Normalize license-board fields → our `contractors` schema (license_number, license_status, license_expires_at, license_classification[])
4. Migration to add the `license_*` columns (nullable for non-license-board rows)
5. Admin route `POST /api/admin/contractors/sync` that takes `{ state, batch_size, since? }` and pulls a slice
6. Dedupe via existing (normalized phone) ∪ (name+address) keys; merge license data onto matching rows from other sources
7. Refresh policy — re-pull rows whose `license_status` is `active` weekly to catch expirations

**Files touched:**
- New: `src/lib/contractors/sources/licenseBoard.ts`, `src/lib/contractors/sources/cslb.ts`, migration `2026XXXX_contractor_licenses.sql`, `app/api/admin/contractors/sync/route.ts`
- Modified: `src/lib/contractors/sources/index.ts` (register `license_board`), `src/lib/contractors/types.ts`

**v1 scope:** CSLB only. TX/FL/NY follow as separate adapters in M4.0a.1 / .2 / .3 — adding a state is a 1-file PR after CSLB lands.

#### M4.0b — SerpAPI adapter activation

**Why:** Vision ¶9. License boards give us licensed-only contractors. SerpAPI's Google Maps endpoint gives us the rest — unlicensed handymen, cleaners, painters, small operations that don't show up in license registries. Display-only data (per SerpAPI ToS we can't persist the full record); we hold a thin index (place_id + name + last_seen) and re-hydrate on demand.

**Sub-tasks:**
1. Implement `src/lib/contractors/sources/serpapi.ts` against the abstract interface
2. ToS-compliant persistence — store `serpapi_place_id`, `name`, `address`, `phone`, `lat`, `lng`, `last_seen_at`; re-hydrate ratings / reviews / hours on display via cached fetch
3. Wire into registry — `CONTRACTOR_DATA_SOURCE=serpapi` becomes a real option
4. Daily re-hydration cron for top-N rows to keep ratings fresh
5. Legal sign-off gate: SG Dietz reviews the SerpAPI-ToS-compliant persistence model with counsel before enabling

**Files touched:** `src/lib/contractors/sources/serpapi.ts`, `src/lib/contractors/sources/index.ts`, `vercel.json` (new cron entry)

#### M4.0c — Contractor self-signup + profile claim

**Why:** Without this, M4.1–M4.9 are uncallable. M1's auth + magic-link works for any user; the new wrinkle is mapping a signing-up user to either (a) an existing contractor row (claim) or (b) a brand-new row.

**Sub-tasks:**
1. New route `/<locale>/for-contractors` — landing page + sign-up CTA
2. Magic-link sign-in (reuse M1 auth); new role enum `users.role IN ('homeowner', 'contractor', 'admin')`
3. Profile claim flow — after sign-in, lookup contractors by `email`. If found → "Is this you? Claim this profile". If not → "Create a new profile".
4. Verification gates per Q4.0c:
   - Email-on-file match: low-friction
   - License number entry: high-trust (cross-reference M4.0a's license_board data)
   - SMS to listed phone: medium-friction
5. Claim approval queue for admin review when the claimer's signal is ambiguous
6. New migration: add `users.contractor_id` (nullable FK), `contractors.claimed_at`, `contractors.claimed_by_user_id`

**Files touched:** New `app/[locale]/for-contractors/page.tsx`, `app/[locale]/contractor/onboarding/page.tsx`, `app/api/contractors/claim/route.ts`, `src/lib/contractors/claim.ts`; migration

#### M4.0d — Contractor dashboard shell + job inbox

**Why:** The contractor's homepage post-login. They need to see:
- Pending job invitations (homeowner picked them, they accept/decline)
- Active jobs (contracts signed, work upcoming)
- Completed jobs
- Subscription status
- Payout history (already in Stripe Connect but surface it here)

**Sub-tasks:**
1. Route `/<locale>/contractor/dashboard` (authenticated, role=contractor only)
2. Job invitation surface — `contracts WHERE contractor_id = me AND status = 'pending' AND signed_at_contractor IS NULL`
3. Accept / decline buttons on each invitation (mutates contract.context.contractor_decision)
4. Active jobs section — contracts paid + appointments upcoming
5. Photo log preview thumbnails (M4.5 dependency)
6. New i18n namespace `contractor.dashboard.*` in all 6 locales

**Files touched:** New `app/[locale]/contractor/dashboard/page.tsx`, panels under `src/components/contractor/`, `src/lib/contractors/jobs.ts`

---

### M4.1 — Tiered contractor subscriptions

**Vision ¶24-25:** *"They will pay a subscription... higher subscription fees for higher tiers of service."*

**Sub-tasks:**
1. Stripe Billing product setup — define tiers (Q4.1a)
2. Stripe customer ↔ contractor link in DB (new column `contractors.stripe_billing_customer_id`)
3. Subscription start / change / cancel routes — `/api/contractors/[id]/subscription/{start,change,cancel}`
4. Webhook handler for Stripe Billing events (separate from M2.5 Connect webhook — different event names)
5. Tier-gating helper `userTierAtLeast(contractorId, tier)` used by other M4 features to lock paid functionality
6. Dashboard section showing current tier, next invoice date, change-plan link

**Stripe products required:**
- Three Price IDs (one per tier) in env: `STRIPE_PRICE_BRONZE`, `STRIPE_PRICE_SILVER`, `STRIPE_PRICE_GOLD`
- New webhook endpoint subscribed to `customer.subscription.{created,updated,deleted}`, `invoice.paid`, `invoice.payment_failed`

**Files touched:** `app/api/contractors/[id]/subscription/*/route.ts`, `app/api/webhooks/stripe-billing/route.ts`, `src/lib/payments/billing.ts`, migration `2026XXXX_contractor_billing.sql`

**Q4.1a tier features — Bert/SG Dietz to finalize.** Recommendation in "Decisions Required" below.

---

### M4.2 — Crew & laborer marketplace inside contractor's 6 chat

**Vision ¶24:** *"can find them new laborers and subcontractors when they need help"*

**Sub-tasks:**
1. New surface variant `crew_marketplace` (drawer panel)
2. Contractor-facing voice intent `find_helper` — e.g., contractor says *"I need a tile-setter for tomorrow's job"*
3. Search backend that queries OTHER contractor rows by category + radius + same-day flag — reuses M2.1 with `same_day=true` and a contractor-side ranking weight
4. Outreach via M1.7 win/lose-style fan-out: contacted helpers get a contractor-to-contractor invitation
5. New table `crew_requests` to track the request + responses
6. Tier gate: silver+ only (per recommended Q4.1a)

**Files touched:** `src/components/AssistantSurface/CrewMarketplacePanel.tsx`, `src/lib/contractors/crew.ts`, `src/lib/intent/rules.ts` (new `find_helper` rule), `src/lib/intent/orchestrator.ts` (handler)

---

### M4.3 — Tool & material checklist agent

**Vision ¶24:** *"rarely forget a tool or the right materials"*

**Sub-tasks:**
1. Per-appointment pre-departure checklist generation — LLM reads the appointment's `agenda` field + the contract's scope + the contractor's category and produces a structured `{ tools: [...], materials: [...], confirmations: [...] }` list
2. Surface as a notification 2 hours before appointment (piggybacks on existing M3.5 cron)
3. New table `appointment_checklists` with the structured items + check-off state
4. Contractor surface: dashboard tile + check-off UI per item
5. v1 storage: LLM generates per-appointment fresh. v1.1 caches by category+scope hash. v2 builds a curated library (Q4.3a — defer)

**Files touched:** `src/lib/appointments/checklist.ts`, `src/components/contractor/ChecklistTile.tsx`, migration

---

### M4.4 — Backup/replacement dispatcher

**Vision ¶33:** *"If contractors don't show, 6 will get contractors that do"*

**Sub-tasks:**
1. Detection trigger — combo of (a) M3.5 reminder cron + (b) homeowner saying "they didn't show" + (c) appointment-time + 30 min without contractor confirmation
2. New job state on `appointments` → `status='no_show'` (already in the CHECK constraint)
3. Re-dispatch flow: re-run M2.2 recommend in `same_day=true` mode, fan out a same-day urgent fan-out (new template `contractor.urgent_dispatch.v1`)
4. Notify the homeowner about the substitute via M1.7
5. New `appointment_replacements` table linking original_appointment_id → replacement_appointment_id for audit

**Files touched:** `src/lib/appointments/dispatch.ts`, `src/lib/notifications/templates/contractor-urgent-dispatch.ts`, new cron `/api/cron/no-show-detector` (5-minute cadence), migration

---

### M4.5 — Daily photo/video job logging

**Vision ¶31:** *"every task in a job will be documented multiple times per day"*

**Sub-tasks:**
1. New table `job_log_entries` (id, appointment_id, contractor_id, taken_at, kind {photo|video|note}, storage_path, gps_lat, gps_lng, caption, ai_caption, context)
2. New Storage bucket `job-logs` (private)
3. Upload route `POST /api/jobs/[appointment_id]/log` accepts multipart photo/video
4. Mobile-first capture UI — `/<locale>/contractor/jobs/[id]/log` opens camera input with `capture="environment"`
5. Geo capture from browser geolocation (best-effort) — verifies contractor is on-site
6. Required-photo prompts — per-checklist-item photos from M4.3 ("photo of completed weed removal")
7. Homeowner-side surface — new variant `job_log` showing the running timeline
8. Day-of-completion summary email via M1.7 with photo thumbnails

**Files touched:** Migration, `app/api/jobs/[id]/log/route.ts`, `src/lib/jobLogs/{store,upload}.ts`, `app/[locale]/contractor/jobs/[id]/log/page.tsx`, new surface variant + panel

---

### M4.6 — Worker-in-the-loop computer vision

**Vision ¶27:** *"6 identifies which plants are weeds and which are flowers ... over time, the Ai will learn and improve its accuracy"*

**Highest schedule risk in M4** — see Risks section.

**Sub-tasks (v1 — minimum-viable):**
1. Use **OpenAI vision** as the model (`gpt-4o` with image input) — no custom training pipeline in v1
2. Worker uploads a photo via M4.5 → backend runs CV → returns `{ label, confidence, alternatives }`
3. Worker confirms/corrects the label inline ("yes weed" / "no flower")
4. New table `cv_labels` storing (photo_id, predicted_label, predicted_confidence, confirmed_label, confirmed_by_user_id, confirmed_at)
5. Use the corrected labels as training-data anchor for a future v2 fine-tune (data collection only in v1)

**Sub-tasks (v2 — deferred to M5):**
- Custom fine-tuned model on Roboflow / HuggingFace
- Visual diff between visits (¶27 second clause)
- Cost-per-call optimization

**Files touched:** `src/lib/vision/classify.ts`, `app/api/jobs/[id]/log/[entry]/classify/route.ts`, migration

**Why this is a risk:** quality of OpenAI vision on weed-vs-flower is unknown without sample data. Run a spike against a hand-curated test set BEFORE committing to the rest of M4.6. If quality is <70% confident-correct, defer the feature.

---

### M4.7 — Recurring / autopilot job scheduler

**Vision ¶33:** *"autopilot, such as their grass mowed, weeds pulled, gutters cleaned, A.C. fixed, driveway snow plowed — anything and everything"*

**Sub-tasks:**
1. New table `recurring_jobs` (id, user_id, contractor_id, contract_id, schedule jsonb, active_from, active_until, paused_at, context)
2. Schedule shape: `{ rrule: "FREQ=WEEKLY;BYDAY=TU;COUNT=24" }` — standard iCalendar RRULE
3. Homeowner voice intent `schedule_recurring` — e.g. *"keep my lawn mowed every Tuesday from May through October"*
4. Cron `/api/cron/recurring-jobs` runs nightly, materializes the next 7 days of appointments from active recurring rows
5. Per-instance autopilot: each materialized appointment fires existing M3.4 + M3.5 reminders; if no_show triggers, M4.4 dispatches a backup
6. Pause / resume / cancel route — homeowner can override any instance
7. End-of-season summary email — "here's your 24-week mowing log"

**Files touched:** Migration, `src/lib/appointments/recurring.ts`, `src/lib/intent/rules.ts` (new `schedule_recurring` rule), `app/api/cron/recurring-jobs/route.ts`, `vercel.json` (daily cron entry)

---

### M4.8 — Positive-coaching nudges for workers & contractors

**Vision ¶28:** *"6 will always be positive and encouraging, helping people be better business owners and employees"*

**Sub-tasks:**
1. Coaching event catalog — define which contractor events trigger which nudge:
   - First 5-star review → celebratory note
   - 3rd repeat customer → "you're building a loyal base"
   - On-time arrival streak → milestone email
   - Late-cancellation → gentle "let's avoid this next time"
   - Profile incomplete after 7 days → "you're missing 40% of your job offers"
2. LLM-generated body text (tone-controlled prompt) — never canned strings
3. Cron `/api/cron/coaching-nudges` runs daily, evaluates events, deduplicates
4. New table `coaching_nudges_sent` for dedup
5. Channel = email (always) + in-app dashboard banner

**Files touched:** `src/lib/coaching/{catalog,trigger,compose}.ts`, `app/api/cron/coaching-nudges/route.ts`, migration

---

### M4.9 — In-person "go-between" mode

**Vision ¶15:** *"6 will also manage the in-person meetings as the go-between, live on one or both phones"*

**Sub-tasks:**
1. New voice intent `go_between_mode` — homeowner says *"6, get on the phone with me while the plumber's here"*
2. Either side opens 6 on their phone, hits "Go-between mode" button
3. Both phones simultaneously transmit audio to the same Twilio conference (M3.1 infrastructure reused — same conference, two separate inbound legs)
4. 6 listens to both sides (already does — M3.1 transcription works); the wake-word "hey 6" works from either party
5. Real difference from M3.1: M3.1 is REMOTE conference (homeowner calls contractor, they're not in same room). M4.9 is LOCAL conference (homeowner + contractor are physically together; 6 mediates linguistic / negotiation / clarification)
6. Surface: shared transcript visible to both sides on their phones — handy when one party can't hear or wants to verify something 6 said

**Files touched:** `src/components/GoBetweenMode/*`, `app/api/calls/go-between/start/route.ts`, voice intent rule

---

## Decisions Required

### Phase 1 — Contractor portal

- **Q4.0a — License board scope and refresh cadence**
  - Options: (a) CSLB only, weekly refresh / (b) CSLB + TX + FL + NY launch set, weekly / (c) all 50 states, monthly
  - **Recommendation:** (a) CSLB only at M4.0a, add TX + FL + NY in M4.0a.1–.3 as separate single-state PRs. Easier to debug one source's quirks at a time.

- **Q4.0b — SerpAPI legal sign-off**
  - SerpAPI returns Google Maps data we're allowed to display but NOT to persist past 24h. Counsel must approve our thin-index + on-demand re-hydration design before enabling.
  - **Recommendation:** start counsel review BEFORE Phase 1 code lands. Adapter code can be ready and gated by env.

- **Q4.0c — Profile claim verification**
  - Options: (a) email-on-file only / (b) license number cross-check / (c) SMS to listed phone / (d) admin manual approval / (e) layered (any of the above)
  - **Recommendation:** (e) layered — accept ANY of email match OR license-number match OR SMS verification; admin review only when zero signals match.

- **Q4.0d — Contractor role gating**
  - Options: (a) any user can flip role to contractor via UI / (b) admin invite only / (c) self-signup but admin-approval required before payout enabled
  - **Recommendation:** (c) — anyone can claim, but Stripe Connect onboarding requires admin approval. Stops random people from spamming the claim queue with fake profiles.

### Phase 2 — Subscriptions + automation

- **Q4.1a — Subscription tiers and feature gates**
  - Recommendation (subject to Bert's market call):
    | Tier | Monthly | Features |
    |---|---|---|
    | Free | $0 | View incoming invitations, manual accept/decline, basic dashboard |
    | Bronze | $29 | Same-day urgent fan-out priority, M4.3 checklist, M4.5 photo log |
    | Silver | $79 | Bronze + M4.2 crew marketplace + M4.4 backup dispatcher + M4.7 recurring jobs |
    | Gold | $199 | Silver + M4.6 CV labeling + M4.8 coaching + featured-card slots in M2.2 recommend |
  - This is **directional**, Bert sets final numbers per ROADMAP M2 ¶130 note ("won't be the final number").

- **Q4.3a — Tool/material checklist source**
  - Options: (a) LLM-generated per appointment / (b) curated per-trade library / (c) hybrid
  - **Recommendation:** (a) for v1; (c) by v1.2 — start with LLM, capture corrections back into a library, swap to library-with-LLM-fallback when accuracy improves.

- **Q4.5a — Photo upload requirements per job**
  - Options: (a) optional always / (b) required: arrival + completion / (c) per-checklist-item required
  - **Recommendation:** (b) v1 — arrival + completion only. Mandate per-checklist-item photos as a paid-tier feature.

- **Q4.5b — Photo storage retention**
  - Options: (a) forever / (b) 365 days / (c) 90 days unless homeowner pins
  - **Recommendation:** (a) for now, indexed by appointment. Vision ¶31 implies the photo log is the historical artifact. Storage is cheap; review at $5k/mo run-rate.

### Phase 3 — Orchestration

- **Q4.2a — Crew marketplace match criteria**
  - Options: (a) category + radius / (b) category + radius + rating + same-day flag / (c) full M2.4 ranking
  - **Recommendation:** (c) — reuse the existing recommendation engine. One ranking system is better than two.

- **Q4.4a — Backup dispatcher trigger threshold**
  - Options: (a) homeowner signals "they didn't show" / (b) appointment time + 30 min without contractor confirmation / (c) both
  - **Recommendation:** (c) — either signal triggers. Sooner is better for same-day work.

- **Q4.9a — Go-between mode activation**
  - Options: (a) explicit user-initiated only / (b) auto-suggested when 6 detects raised voices / (c) always-on during scheduled appointments
  - **Recommendation:** (a) v1. (b) is cool but raises false-positive risk + privacy questions.

### Phase 4 — Vision

- **Q4.6a — CV provider**
  - Options: (a) OpenAI Vision (`gpt-4o`) / (b) Roboflow with custom model / (c) Custom HuggingFace fine-tune
  - **Recommendation:** (a) for v1. Zero training-data investment, immediate ship. Migrate to (b) once we have >1000 labeled samples.

- **Q4.6b — CV quality acceptance bar**
  - Options: (a) ship at any quality, worker corrects / (b) gate behind 70% test-set accuracy / (c) gate behind 85%
  - **Recommendation:** (b) — 70% means 7 of 10 predictions are right; worker correction is fast for the other 3. Below 70%, the feature is annoying.

---

## What SG Dietz Must Provide — In Order of Need

| Priority | Item | Lead time |
|---|---|---|
| 1 | SerpAPI legal sign-off (counsel) — gated by ToS-compliant persistence model in M4.0b | 1–2 weeks |
| 2 | Subscription pricing finalization (Q4.1a) | Same day — Bert call |
| 3 | Stripe Billing products created in the dashboard + Price IDs handed back | 30 min once tiers locked |
| 4 | Contractor ToS text (separate from homeowner ToS — counsel) | 1–2 weeks |
| 5 | Recording consent preamble approval (carry-over from M3 — still needed) | Same day |
| 6 | License-board data access for non-CSLB states (mostly free, but TX may require account) | Same day to 1 week per state |
| 7 | CV training-data labeling budget (M4.6 v2) | Defer to M5 |
| 8 | Customer-success / coaching tone guide for M4.8 LLM prompt | 1 week — Bert + SG Dietz draft |

---

## Risks

1. **M4.6 computer vision is the schedule wildcard.** OpenAI Vision quality on weed-vs-flower is unknown. **Spike first**, ship-or-defer second. Carry to M5 cleanly if the spike fails — no other M4 feature depends on M4.6.

2. **M4.1 subscription churn risk.** Even great contractors will hesitate to pay before seeing value. v1 should include a free trial (14d?) for every new signup. Free-tier should be functional enough that contractors stay logged in.

3. **License-board data is messy.** Different states publish in different formats; some have CAPTCHAs. CSLB has a clean DPL API. TX is FOIA-style — slower. v1 ships CSLB and the abstract interface; other states are isolated workstreams.

4. **Contractor verification is operationally novel for us.** We've never had to verify someone IS who they say they are. Q4.0c's layered approach (email + license + SMS, admin fallback) is the right shape, but expect operational tuning during M4.0c rollout.

5. **Stripe Billing + Stripe Connect coexistence.** Two webhook endpoints, two product types, sometimes the same Stripe Customer. Watch for the dual-link confusion — `contractors.stripe_billing_customer_id` (Billing) and `contractors.stripe_connect_account_id` (Connect) are different identifiers despite both saying "Stripe".

6. **M4.5 photo storage growth.** A single active contractor at 5 jobs/day with 4 photos each = 20 uploads/day = ~600/month. At 100 contractors that's 60k photos/month. Supabase Storage at $0.021/GB is fine until ~50TB; budget for $50–200/month at M4 scale.

7. **M4.7 recurring jobs and cron drift.** Materializing 7 days at a time is robust to a missed nightly run; but a missed run that lasts 7+ days could leave an active recurring job with no upcoming instances. Add a watchdog that alerts when an active recurring row has zero future appointments.

---

## Dependencies graph

```
M4.0a license-board ──┐
M4.0b SerpAPI ────────┼──→ M4.0c claim ──→ M4.0d dashboard ──┐
                      │                                       │
                      │                                       ├──→ M4.1 subscriptions
                      │                                       ├──→ M4.2 crew marketplace
                      │                                       ├──→ M4.3 checklist
                      │                                       ├──→ M4.5 photo log ──→ M4.6 CV
                      │                                       ├──→ M4.7 recurring autopilot
                      │                                       ├──→ M4.8 coaching nudges
                      │                                       │
M3.4 + M3.5 ──────────┼───────────────────────────────────────┼──→ M4.4 backup dispatch
M3.1 calls ───────────┘                                       └──→ M4.9 go-between
```

**Critical path:** M4.0a or M4.0b → M4.0c → M4.0d → (everything else). Phase 1 is the bottleneck; Phases 2–4 parallelize after.

---

## Definition of Done for M4

The roadmap exit criteria, expanded:

- [ ] A contractor in a real state (start with California) can self-signup, claim their licensed profile via license-number cross-check, and complete Stripe Connect onboarding without admin intervention
- [ ] That contractor can subscribe to a paid tier and the subscription's value props (M4.2 / M4.3 / M4.5 / M4.7) are gated correctly
- [ ] A homeowner can ask 6 for a recurring job ("mow every Tuesday May–October") and have it run for 24 consecutive weeks with zero re-engagement, including reminder firing, photo log capture, and end-of-season summary
- [ ] When a contractor doesn't show, M4.4 detects it within 30 min and dispatches a same-day backup
- [ ] M4.6 ships at >= 70% test-set accuracy on weed-vs-flower, OR is deferred to M5 with the spike result documented
- [ ] M4.8 coaching nudges are firing for at least 3 event types with LLM-generated bodies that pass tone review
- [ ] M4.9 go-between mode works end-to-end with the homeowner + contractor in the same room and 6 on both phones

**Acceptable partial-M4 outcome:** if M4.6 CV spike fails, M4 still ships M4.0–M4.5 + M4.7 + M4.8 + M4.9 (CV deferred). M4.4 backup dispatcher is the only feature that has any external dependency (M2.6 fan-out, already shipped).

---

## What's NOT in M4 (deferred or beyond scope)

For Bert to push back on if any of these should move forward:

- **Marketplace expansion** — more cities, more categories. Already supported by the data layer; just needs more seeds. Roadmap M5 territory.
- **Mobile native apps** — PWA polish in M4 covers 90% of mobile UX; native is M6+.
- **White-label / multi-tenant** — not in vision.
- **Real-time team chat between contractor and crew** — M4.2 fan-out is async (text/email); synchronous chat is M5.
- **Data buyer portal** — Roadmap M5.6.
- **Contractor analytics dashboards** — basic dashboard tiles in M4.0d cover "you have N jobs this week"; deep analytics is M5+.

---

## Open questions for Bert

These are decisions that need a yes/no/redirect before code commits in earnest:

1. **Does M4.0a launch with CSLB only or with the full launch set (CSLB + TX + FL + NY)?** Affects calendar weeks 1–3 of Phase 1.
2. **Subscription pricing — confident enough to publish, or do you want to soft-launch with "TBD pricing during beta" and lock numbers post-test-drive?**
3. **Is the M4 build kicking off now or after G's M3 test-drive lands?** If the test-drive surfaces M3 regressions, M4 waits.
4. **Counsel relationship for contractor ToS + SerpAPI sign-off + recording consent — is that on retainer or one-off?** Affects how parallel legal review can run alongside dev.
5. **M4.6 CV spike — do it inside M4 or break out as a parallel research stream?**

---

## Revision history

| # | Change | Author |
|---|---|---|
| 1 | Initial M4 build order, drafted from ROADMAP.md scope | Bert / Claude |
