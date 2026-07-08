l# iSolveUrProblems — Milestone 4 Delivery

> Date marked code-complete: 2026-07-03
> Source vision: `20260326-iSolveUrProblems-LASTB4MOVE2DROPBOX.docx`
> Companion docs: [ROADMAP.md](ROADMAP.md), [M4-BUILD-ORDER.md](M4-BUILD-ORDER.md), [M4-EXIT-GATE-REHEARSAL.md](M4-EXIT-GATE-REHEARSAL.md), [M3-DELIVERY.md](M3-DELIVERY.md)

This document tells you:

1. **What shipped in M4** — every vision-anchored feature with file paths and commits.
2. **How to verify each feature in the running app** — click-by-click / voice-by-voice playbook per feature, with SQL verifications.
3. **What G needs to do to make this production-ready** — vendor procurement, legal sign-offs, security hardening, and monitoring.

Migrations are already applied — every SQL check below assumes the M4 schema is live.

---

## TL;DR

**Every M4 feature is code-complete on `main`.** Typecheck green. All 8 M4 migrations applied. The homeowner side stays as M3 shipped it; the contractor side is now a full two-sided product.

M4 introduces three structural shifts:

1. **The contractor portal lands.** Contractors self-signup, claim their licensed profile via CSLB license-number cross-check, land on a dashboard with job inbox + payout status + subscription tile.
2. **Stripe Billing joins Stripe Connect.** Monthly subscriptions from contractors (Bronze / Silver / Gold) now run alongside the M2.5 per-job Connect payouts.
3. **The job lifecycle gains an autopilot.** A homeowner asks 6 *"keep my lawn mowed every Tuesday from May through October"* → 6 picks a contractor → every week the appointment materializes, reminders fire, checklist generates, photos log, AI labels, no-show detection dispatches a backup, coaching nudges fire — **with zero homeowner re-engagement** for the whole 24-week season.

That end-to-end story is the M4 exit gate. See [M4-EXIT-GATE-REHEARSAL.md](M4-EXIT-GATE-REHEARSAL.md) for the compressed one-day walkthrough.

---

## What shipped

| # | Feature | Vision anchor | Commit | Key files |
|---|---|---|---|---|
| M4.0a | CSLB license-board contractor sync | Vision ¶9 | `7156ccb` | `src/lib/contractors/sources/{licenseBoard,cslb}.ts`, `src/lib/contractors/licenseSync.ts` |
| M4.0b | SerpAPI adapter (gated by legal sign-off) | Vision ¶9 | `7156ccb` | `src/lib/contractors/sources/serpapi.ts` |
| M4.0c | Contractor self-signup + profile claim | Operational | `1bd6fea` | `app/[locale]/for-contractors/*`, `app/api/contractors/claim/route.ts`, `src/lib/contractors/claim.ts` |
| M4.0d | Contractor dashboard shell + job inbox | Operational | `1bd6fea` | `app/[locale]/contractor/dashboard/page.tsx`, `src/lib/contractors/jobs.ts` |
| M4.1 | Tiered subscriptions (Stripe Billing) | Vision ¶24-25 | `f542d1c` | `src/lib/billing/*`, `app/api/contractors/[id]/subscription/*`, `app/api/webhooks/stripe-billing/route.ts`, `src/components/contractor/SubscriptionPanel.tsx` |
| M4.2 | Crew & laborer marketplace | Vision ¶24 | `ddc7508` | `src/lib/crew/*`, `app/api/crew/requests/route.ts`, `src/components/contractor/CrewMarketplaceTile.tsx` |
| M4.3 | Pre-departure tool/material checklist | Vision ¶24 | `21112f4` | `src/lib/appointments/checklist.ts`, `src/components/contractor/ChecklistTile.tsx`, `app/api/appointments/[id]/checklist/*` |
| M4.4 | Backup / no-show dispatcher | Vision ¶33 | `ce0f451`, `3660ee8` | `src/lib/appointments/dispatch.ts`, `app/api/cron/no-show-detector/route.ts`, `app/api/appointments/[id]/no-show/route.ts`, `src/lib/notifications/templates/contractor-urgent-dispatch.ts` |
| M4.5 | Daily photo / video job log | Vision ¶31 | `79ab629` | `src/lib/jobLogs/*`, `app/api/jobs/[id]/log/route.ts`, `app/[locale]/contractor/jobs/[id]/log/page.tsx`, `src/components/contractor/JobLogCapture.tsx` |
| M4.6 | Worker-in-the-loop CV labeling (v1) | Vision ¶27 | `d2aa0ef`, `3660ee8` | `src/lib/vision/{classify,store}.ts`, `app/api/jobs/[id]/log/[entry]/classify/*`, `app/api/appointments/[id]/cv-labels/route.ts`, `src/components/contractor/CvLabelChip.tsx` |
| M4.7 | Recurring / autopilot job scheduler | Vision ¶33 | `ce83f6f` | `src/lib/recurring/*`, `app/api/cron/recurring-jobs/route.ts` |
| M4.8 | Positive-coaching nudges | Vision ¶28 | `8eae5cd` | `src/lib/coaching/*`, `app/api/cron/coaching-nudges/route.ts` |
| M4.9 | In-person go-between mediation | Vision ¶15 | `46f6dca`, `3660ee8` | `app/api/calls/go-between/start/route.ts`, `src/components/GoBetweenMode/StartButton.tsx`, `src/lib/calls/authz.ts` |

Post-review fix-up commits (`3660ee8` and a follow-up patch): context-clobber fix on M4.4, nuisance-call defense on both `/api/calls/start` (M3.1) and `/api/calls/go-between/start` (M4.9), classify-dedupe on M4.6, homeowner-RLS confirmed-label filter on M4.6, plus quality fixes (E164 regex extraction, cron concurrency cap, telemetry hardening, N+1 batch fetch on the CV chip).

---

## Configuration items needed before launch

| # | Item | Owner | Lead time | Blocks |
|---|---|---|---|---|
| 1 | Create Supabase Storage bucket `job-logs` (**PRIVATE** — signed URLs on demand) | Bert | 2 min | M4.5 |
| 2 | Enable the two new Vercel cron entries — `no-show-detector` (`*/5 * * * *`) and confirm `recurring-jobs` (`0 2 * * *`) + `coaching-nudges` (`0 14 * * *`) already enabled | Bert | 1 min | M4.4, M4.7, M4.8 |
| 3 | Create Stripe Billing products (Bronze $29 / Silver $79 / Gold $199) → paste Price IDs into `STRIPE_PRICE_BRONZE` / `STRIPE_PRICE_SILVER` / `STRIPE_PRICE_GOLD` | G + Bert | Same day | M4.1 |
| 4 | Wire the Stripe Billing webhook endpoint (`/api/webhooks/stripe-billing`) → subscribe to `customer.subscription.{created,updated,deleted}`, `invoice.paid`, `invoice.payment_failed`; paste signing secret into `STRIPE_BILLING_WEBHOOK_SECRET` | Bert | 5 min | M4.1 |
| 5 | Set `ADMIN_SECRET` so the CSLB sync endpoint works | Bert | 1 min | M4.0a real-data pull |
| 6 | Set `CRON_SECRET` (if not already set for M3.5) | Bert | 1 min | M4.4, M4.7, M4.8 crons |
| 7 | Verify Twilio Voice env from M3.1 (`TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_VOICE_FROM_NUMBER`, `APP_PUBLIC_BASE_URL`) — reused by M4.9 | Bert | Same day | M4.9 |
| 8 | Verify Resend/`RESEND_API_KEY` + `NOTIFICATION_FROM_EMAIL` from M1.7 — reused by M4.4 dispatch, M4.5 completion summary, M4.8 nudges | Bert | Same day | M4.4, M4.5 emails, M4.8 emails |
| 9 | Ensure `OPENAI_API_KEY` covers M4.3 (checklist), M4.6 (vision), M4.8 (nudge tone) | Bert | Same day | M4.3, M4.6, M4.8 |
| 10 | **G / SG Dietz — legal sign-off items** — see Part 3.B below | G | 1–2 weeks per item | Contractor ToS, SerpAPI persistence, CV data consent |
| 11 | **G / SG Dietz — subscription pricing finalization** — the $29/$79/$199 above is directional (Q4.1a); lock or override before Stripe products go live | G | Same day | Item 3 |

Once items 1–9 are done, every M4 feature verifies end-to-end against Stripe TEST keys with mock/seed data. Item 10 (legal) gates going public with real contractors + real homeowners.

---

## Part 2 — Per-feature verification playbook

Each subsection lists:

- **Do:** what to click / say in the app
- **Expect:** what should be visible
- **Verify:** an SQL query or route response confirming the side-effect

Every subsection assumes you're signed in as a homeowner unless it says otherwise. Sign-out + private-window steps are called out explicitly.

### Prep — Seed a Californian licensed landscaper

For M4.0c / M4.1 / M4.7 / M4.4 verification you need one contractor whose profile a signup can claim.

```powershell
# Path A: mock seed + fake license (fastest — no external calls)
$secret = (Get-Content apps/demo/.env.local | Select-String "ADMIN_SECRET" | ForEach-Object { ($_ -split "=", 2)[1] })
Invoke-RestMethod `
  -Uri "http://localhost:3001/api/admin/contractors/seed" `
  -Method POST `
  -Headers @{ "Authorization" = "Bearer $secret"; "Content-Type" = "application/json" } `
  -Body '{ "categories": ["landscaper"], "per_category": 10 }'
```

Then in SQL, pretend one row is CSLB-verified:

```sql
update public.contractors
set license_number     = 'CA-1234567',
    license_status     = 'active',
    license_expires_at = '2027-12-31',
    email              = 'testcontractor@example.com'
where 'landscaper' = any(categories)
order by rating_avg desc nulls last
limit 1
returning id, name, email;
```

Copy the returned `id` — you'll paste it into several later steps.

**Path B (tests M4.0a end-to-end against the real CSLB DPL endpoint):**

```powershell
Invoke-RestMethod `
  -Uri "http://localhost:3001/api/admin/contractors/sync" `
  -Method POST `
  -Headers @{ "Authorization" = "Bearer $secret"; "Content-Type" = "application/json" } `
  -Body '{ "state": "CA", "batch_size": 25, "category": "landscaper" }'
```

Then verify: `select id, name, license_number, license_status from public.contractors where license_status = 'active' limit 5;`

---

### M4.0a — CSLB license-board sync

**Do:** hit the admin sync route as shown in "Prep — Path B" above.

**Expect:** the route returns `{ ok: true, upserted: N }` with N ≥ 1.

**Verify:**

```sql
-- Rows now carry license_* columns
select id, name, license_number, license_status, license_expires_at
from public.contractors
where license_number is not null
limit 10;
```

**Anchored to:** Vision ¶9 (*"scraping the internet"*), M4.0a build-doc entry.

---

### M4.0b — SerpAPI adapter (gated)

**Skip this section if the SerpAPI ToS-compliant persistence model has not yet been legally reviewed** (see Part 3.B item 2). The adapter code is complete but the env-var gate means it's inert until enabled.

**Do (once legal signs off):** set `CONTRACTOR_DATA_SOURCE=serpapi` + `SERPAPI_API_KEY=…` and re-hit the seed route with a non-license-board category (e.g. `handyman`).

**Expect:** rows with `serpapi_place_id` populated; `phone`, `lat`, `lng`, `last_seen_at` filled.

**Verify:**

```sql
select id, name, serpapi_place_id, last_seen_at
from public.contractors
where serpapi_place_id is not null
limit 5;
```

---

### M4.0c — Contractor self-signup + profile claim

**Do:**
- Open a private window → `http://localhost:3001/en/for-contractors`
- Sign in with a **different email** than your homeowner one — this is your contractor identity
- On the claim form, enter the license number `CA-1234567` (from Prep) and submit

**Expect:** you land on `/en/contractor/dashboard`; header shows the contractor's name.

**Verify:**

```sql
select id, claimed_by_user_id, claimed_at
from public.contractors
where license_number = 'CA-1234567';

-- users.role should now be 'contractor' and users.contractor_id set
select id, email, role, contractor_id from public.users where email = 'YOUR-CONTRACTOR-EMAIL';
```

**Anchored to:** M4.0c build-doc; Q4.0c layered verification (license number is the high-trust path).

---

### M4.0d — Contractor dashboard shell + job inbox

**Do:** while signed in as the contractor from M4.0c, stay on `/en/contractor/dashboard`.

**Expect:** three sections visible:
- Pending job invitations (if any contracts exist against this contractor)
- Active jobs (paid contracts with upcoming appointments)
- Completed jobs
Plus the SubscriptionPanel, the ConnectOnboardButton (unless already onboarded), and CrewMarketplaceTile.

**Verify:**

```sql
-- Row counts by section, for a contractor whose id is <cid>:
select
  (select count(*) from public.contracts where contractor_id = '<cid>' and status = 'pending')     as pending,
  (select count(*) from public.appointments where contractor_id = '<cid>' and status = 'scheduled') as active,
  (select count(*) from public.appointments where contractor_id = '<cid>' and status = 'completed') as completed;
```

**Anchored to:** M4.0d build-doc.

---

### M4.1 — Tiered subscriptions

**Do:** on the contractor dashboard, click **Upgrade to Gold** in the SubscriptionPanel.

**Expect:** redirect to Stripe Checkout in test mode. Pay with `4242 4242 4242 4242`, any future expiry, any CVC. Back on the dashboard, tier badge should read **Gold**.

**Verify:**

```sql
select tier, status, stripe_subscription_id, current_period_end
from public.contractor_billing_subscriptions
where contractor_id = '<cid>';
-- Expected: ('gold', 'active', 'sub_...', <future date>)
```

Also verify the webhook fired:

```sql
select id, event_type, created_at
from public.stripe_events   -- or whatever your webhook-audit table is named
where event_type like 'customer.subscription.%'
order by created_at desc limit 5;
```

**Downgrade path:** click **Manage subscription** → Stripe customer portal → change plan to Silver. Within seconds the DB row updates.

**Anchored to:** Vision ¶24-25, M4.1 build-doc.

---

### M4.2 — Crew marketplace

**Do (as contractor):**
- The dashboard shows a CrewMarketplaceTile (silver+ tier only — the Gold subscription from M4.1 qualifies)
- Click **Request a helper** → fill category (e.g. "handyman"), radius, needed_at
- Submit

**Expect:** a `crew_requests` row is inserted; the panel switches to "invitations sent" and shows a count of contractors who received the invitation. Fan-out is via M1.7 email templates (`crew.invitation.v1`) — check the Resend logs.

**Voice path (alternate):** say *"I need a tile-setter for tomorrow's job"* while signed in as a Silver+ contractor.

**Verify:**

```sql
select id, requesting_contractor_id, category, needed_at, radius_km, status
from public.crew_requests
order by created_at desc limit 1;

select responder_contractor_id, response, responded_at
from public.crew_request_responses
where request_id = '<request_id>';
```

**First-accept-wins:** as another contractor (create a second claimed profile), click **Accept** on the invitation email. The request status flips to `filled` and losing invitees get a `crew.filled.v1` follow-up email.

**Anchored to:** Vision ¶24, M4.2 build-doc.

---

### M4.3 — Pre-departure checklist

**Do:**
- Create a fresh appointment (say *"Schedule the mowing for tomorrow at 10am"*)
- Time-warp it into the 24-hour reminder window:

```sql
update public.appointments
set scheduled_at = now() + interval '25 hours', reminder_24h_sent_at = null, checklist_notified_at = null
where id = '<appt_id>';
```

- Fire the reminder cron:

```powershell
$cronSecret = (Get-Content apps/demo/.env.local | Select-String "CRON_SECRET" | ForEach-Object { ($_ -split "=", 2)[1] })
Invoke-RestMethod -Uri "http://localhost:3001/api/cron/appointment-reminders" -Headers @{ Authorization = "Bearer $cronSecret" }
```

**Expect:** the reminder + checklist notification fire in one pass.

**Verify:**

```sql
select reminder_24h_sent_at, checklist_notified_at from public.appointments where id = '<appt_id>';

select items, model, generated_at
from public.appointment_checklists
where appointment_id = '<appt_id>';
```

The `items` JSON should have 5–12 rows of `{ kind: "tool" | "material" | "confirmation", text: "…" }`.

**As contractor:** navigate to the ChecklistTile on the dashboard → tick items off. Rows in `appointment_checklists.items` gain `checked_at` + `checked_by_user_id`.

**Anchored to:** Vision ¶24 (*"rarely forget a tool or the right materials"*), M4.3 build-doc.

---

### M4.4 — Backup / no-show dispatcher

Two triggers converge: cron detection and homeowner voice report.

**Cron path:**
- Grab a fresh scheduled appointment, time-warp into the no-show window:

```sql
update public.appointments
set scheduled_at        = now() - interval '45 minutes',
    contractor_confirmed_at = null,
    no_show_detected_at = null,
    status              = 'scheduled'
where id = '<appt_id>';
```

- Hit the detector:

```powershell
Invoke-RestMethod -Uri "http://localhost:3001/api/cron/no-show-detector" -Headers @{ Authorization = "Bearer $cronSecret" }
```

**Expect:** the response body's `results` array includes your appointment with a dispatch result (either invited N contractors or `skipped_reason: "no_invitables"` if none are seeded nearby).

**Verify:**

```sql
select status, no_show_detected_at from public.appointments where id = '<appt_id>';
-- Expected: ('no_show', <now>)

select trigger, invited_count, context->>'skipped_reason' as skipped_reason, context->>'total_considered' as total_considered
from public.appointment_replacements
where original_appointment_id = '<appt_id>';
```

If `invited_count > 0`, candidates with emails receive the `contractor.urgent_dispatch.v1` template.

**Homeowner voice path:**
- Sign back in as the homeowner
- On a **different** freshly-scheduled appointment that's within the past 4 hours + still `contractor_confirmed_at IS NULL`, say *"They didn't show up."*

**Expect:** appointment panel with header "Dispatching a substitute". Same row-level side effects.

**Race telemetry:** if both cron and homeowner fire for the same appointment, only one wins the CAS; the loser's trigger is appended to the winner's `appointment_replacements.context.additional_triggers` array (verifiable by re-inspecting the row above).

**Anchored to:** Vision ¶33 (*"If contractors don't show, 6 will get contractors that do"*), M4.4 build-doc.

---

### M4.5 — Daily photo / video job log

**Do (as contractor, from dashboard):**
- Click into any active job → land on `/en/contractor/jobs/<appt_id>/log`
- Tap **Arrival** → device camera opens (mobile-first — best tested on a phone; desktop browsers show a file picker)
- Capture a photo, submit

**Expect:** the photo appears in the timeline within 1–2 seconds. Best-effort GPS is captured from the browser (works only over HTTPS + user permission).

**Verify:**

```sql
select id, kind, phase, storage_path, gps_lat, gps_lng, taken_at
from public.job_log_entries
where appointment_id = '<appt_id>'
order by taken_at desc;

-- Side effect: the first arrival photo also flips M4.4 arrival confirmation
select contractor_confirmed_at from public.appointments where id = '<appt_id>';
```

**Homeowner view:** sign back in as homeowner, ask 6 *"What did the plumber do today?"* — the drawer shows the timeline with thumbnails. Signed URLs are 1-hour TTL.

**Anchored to:** Vision ¶31 (*"every task in a job will be documented multiple times per day"*), M4.5 build-doc.

---

### M4.6 — Worker-in-the-loop CV labeling

**Requires** the contractor to be on the Gold tier (from M4.1). The chip is hidden / gated for lower tiers.

**Do (as contractor, on the job-log page from M4.5):**
- Below the arrival photo, tap **Identify with 6**
- Chip transitions idle → classifying (3–8s) → predicted

**Expect:** predicted label (e.g. `weed`, `dandelion`, `lawn`) + a bucketed confidence (low / medium / high) + up to 3 alternatives.

**Verify:**

```sql
select model, predicted_label, predicted_confidence, alternatives, created_at
from public.cv_labels
where job_log_entry_id = '<entry_id>'
order by created_at desc limit 1;
```

**Confirm the label:** tap **Yes** → row updates with `confirmed_correct = true`, `confirmed_label = <predicted_label>`.
**Correct the label:** tap **No** → text input → type `dandelion` → Save → row updates with `confirmed_correct = false`, `confirmed_label = 'dandelion'`.

The confirmed subset is the training-data anchor set for a future v2 fine-tune. Query:

```sql
select count(*) filter (where confirmed_correct = true)  as correct,
       count(*) filter (where confirmed_correct = false) as corrected,
       count(*)                                          as confirmed_total
from public.cv_labels
where confirmed_label is not null;
```

**Dedupe check:** double-tap the **Identify with 6** button. Only one gpt-4o call fires — the second reads the existing row (< 30s old) and returns `{ deduped: true }`.

**Homeowner view (post-fix migration):** as homeowner, ask 6 *"What was in the arrival photo?"* — only **confirmed** labels are visible per the RLS filter added in `20260705_m4_cv_labels_homeowner_confirmed_only.sql`. Unconfirmed predictions never leak.

**Q4.6b spike gate:** for production, hand-verify 10 varied photos against the model. If ≥ 7/10 predictions match the confirmed-correct answer, ship. If < 7/10, defer per the M4 build doc's acceptable-partial-outcome clause.

**Anchored to:** Vision ¶27 (*"6 identifies which plants are weeds and which are flowers"*), M4.6 build-doc.

---

### M4.7 — Recurring / autopilot job scheduler

**Do (as homeowner):** say *"Keep my lawn mowed every Tuesday from May through October."*

**Expect:** the drawer flips to the **Autopilot job scheduled** panel showing the cadence (e.g. "Every Tuesday at 10:00 AM, May through October") and the next 3 instances. 6 confirms verbally.

**Verify:**

```sql
select id, title, agenda, schedule, timezone, active_from, active_until, status
from public.recurring_jobs
order by created_at desc limit 1;
```

**Cron materialization:**

```powershell
Invoke-RestMethod -Uri "http://localhost:3001/api/cron/recurring-jobs" -Headers @{ Authorization = "Bearer $cronSecret" }
```

**Expect:** response body: `{ ran_at: ..., materialized: N }` with N ≥ 1.

**Verify:**

```sql
select id, scheduled_at, agenda, status, context->>'source' as source
from public.appointments
where context->>'source' = 'recurring'
order by scheduled_at
limit 5;
-- Each row is a materialized instance from the recurring job
```

Each materialized instance fires the normal M3.5 reminder + M4.3 checklist + M4.4 no-show detection pipeline — nothing new to wire.

**Pause / resume:** say *"Pause the lawn mowing"* → `recurring_jobs.status` flips to `paused`, next cron run stops materializing new instances.

**Anchored to:** Vision ¶33 (*"autopilot ... grass mowed, weeds pulled, gutters cleaned"*), M4.7 build-doc.

---

### M4.8 — Positive-coaching nudges

**Do:**

```powershell
Invoke-RestMethod -Uri "http://localhost:3001/api/cron/coaching-nudges" -Headers @{ Authorization = "Bearer $cronSecret" }
```

**Expect:** response includes counts of events considered + nudges sent.

**Verify:**

```sql
select event_kind, subject, dedup_key, sent_at
from public.coaching_nudges_sent
order by created_at desc limit 10;
```

Event kinds seeded in the catalog: `first_five_star_review`, `third_repeat_customer`, `on_time_streak`, `late_cancellation`, `profile_incomplete_7d`.

**Dedup check:** run the cron a second time immediately — no new rows should appear for events that already fired. This proves the `dedup_key` on `coaching_nudges_sent` is doing its job.

**Seeding an event for testing:** if no real event data exists, force a streak:

```sql
update public.appointments
set status                  = 'completed',
    contractor_confirmed_at = scheduled_at + interval '2 minutes'
where contractor_id = '<cid>'
  and scheduled_at < now()
limit 3;
```

Then re-run the cron.

**Tone check (Bert):** open the sent nudge in the contractor's inbox. Does the body sound like a supportive coach? If not, tune the compose prompt at `src/lib/coaching/compose.ts`.

**Anchored to:** Vision ¶28 (*"positive and encouraging, helping people be better business owners"*), M4.8 build-doc.

---

### M4.9 — In-person go-between mediation

**Requires** the M3.1 Twilio config to be live. In local dev without ngrok, Twilio can't reach the callback URLs — skip until staging.

**Do (as homeowner, on a phone, with the target contractor physically present):**
- Ensure the homeowner has an E.164 phone on their `users.phone` field
- Ensure the contractor has an E.164 phone on `contractors.phone`
- The homeowner already has a contract / appointment / prior call linking them (nuisance-call defense — see Part 3.C)
- Say *"6, get on the phone with me while the landscaper's here."*

**Expect:** the CallPanel opens with the **"Go-between"** badge + "In-person go-between" title. Twilio dials both phones. 6 says *"Put me on speaker so both of you can hear me."*

**Verify:**

```sql
select id, context->>'mode' as mode, status, twilio_call_sid_user, twilio_call_sid_contractor
from public.calls
order by created_at desc limit 1;
-- Expected: ('...', 'go_between', 'dialing' → 'in_progress', <sid>, <sid>)
```

Live transcript lines stream into `transcripts` as either party speaks — identical schema to M3.1.

Address 6 by name during the call: *"Hey 6, does the price sound fair?"* — 6 speaks back into the conference via Twilio Conference Announce, audible to both parties.

**Nuisance-call defense:** if the homeowner has never contracted / scheduled / called with the contractor, the route returns 403 (fix landed in `3660ee8`).

**Anchored to:** Vision ¶15 (*"manage the in-person meetings as the go-between, live on one or both phones"*), M4.9 build-doc.

---

## Part 3 — Production hardening (G's action list)

Everything in Part 2 verifies against Stripe test keys + mock/seed data on `main`. Before real contractors + real homeowners hit the app, complete the items below.

### 3.A — Vendor procurement

| # | Item | Who | Notes |
|---|---|---|---|
| 1 | **Stripe Billing products** created and Price IDs pasted into env | G + Bert | Q4.1a — final pricing decision required from G. $29 / $79 / $199 is directional. |
| 2 | **Stripe Billing webhook endpoint** subscribed to `customer.subscription.*` + `invoice.paid` + `invoice.payment_failed` | Bert | Signing secret → `STRIPE_BILLING_WEBHOOK_SECRET`. |
| 3 | **CSLB data access** (California) — the public DPL endpoint has no key, but rate-limits harden after ~50 req/hr | Bert | Add a nightly refresh cron for `license_status = 'active'` rows once we have real usage. |
| 4 | **License-board access for TX / FL / NY** | G | Same-day for TX + FL (FOIA-style public downloads). NY requires an account. Not blocking M4 launch — CSLB alone gets us California. |
| 5 | **SerpAPI account + key** — `SERPAPI_API_KEY` | Bert | Gated by legal item 3.B.2 below. |
| 6 | **Twilio SHAKEN/STIR verification** for the outbound `TWILIO_VOICE_FROM_NUMBER` | Bert | Contractors' carriers may block unverified caller IDs → both the M3.1 and M4.9 dial paths break silently. Verification takes 1–3 business days. |
| 7 | **OpenAI spend cap** on the account, at ~2× projected monthly | G | M4.6 vision calls are the biggest cost lever. Set a hard cap; add per-contractor daily caps in code once we see real usage (currently only IP-scoped rate limits). |
| 8 | **Resend sender domain verified** (carry-over from M1.7) | Bert | Blocks email templates from delivering at all. |

### 3.B — Legal sign-offs

The most calendar-sensitive part of M4 productionization. Start these in parallel with dev.

| # | Item | Who | Lead time | Blocks |
|---|---|---|---|---|
| 1 | **Contractor Terms of Service** — separate document from the homeowner ToS. Covers subscription billing, payout terms, dispute mediation, data usage, revocation | G + counsel | 1–2 weeks | Real contractor signups (M4.0c) |
| 2 | **SerpAPI ToS-compliant persistence** review — our design is a thin index (place_id + name + last_seen) + on-demand re-hydration. Counsel confirms we're within Google Maps' ToS via SerpAPI's redistribution terms | G + counsel | 1–2 weeks | M4.0b activation |
| 3 | **Recording-consent preamble** — carry-over from M3.1 for Twilio Voice recording. Both M3.1 and M4.9 need this; it's a `<Say>` at the start of the conference. Counsel approves wording | G + counsel | Same day (already known text) | M3.1, M4.9 real calls |
| 4 | **CV data-labeling consent** — does gpt-4o retain uploaded photos? If yes, contractors need consent language for job photos being processed by a third party. Counsel + OpenAI DPA review | G + counsel | 1 week | M4.6 production activation |
| 5 | **Stripe Billing tax handling** — Stripe Tax add-on vs. manual per-state. G decides based on volume projection | G | 1 week | Real revenue collection at scale |
| 6 | **Contractor payout timing / refund policy** — new dispute scenarios: contractor subscribes then can't get jobs — is subscription refundable? Codify in the ToS | G | Bundled with item 1 | — |

### 3.C — Security hardening

Items already landed in `3660ee8` post-review fix-up commit are marked ✅. Everything else is still to do.

| # | Item | Status | Notes |
|---|---|---|---|
| 1 | Nuisance-call defense on `/api/calls/start` (M3.1) | ✅ Landed | Requires prior contract / appointment / call with the target contractor. |
| 2 | Nuisance-call defense on `/api/calls/go-between/start` (M4.9) | ✅ Landed | Same check, same helper (`src/lib/calls/authz.ts`). |
| 3 | M4.4 audit-row context clobber fix | ✅ Landed | PostgREST PATCH replaced whole `context` JSONB before. |
| 4 | M4.6 classify dedupe (30s window) | ✅ Landed | Prevents double-tap → double OpenAI charge. |
| 5 | M4.6 homeowner RLS: only confirmed labels | ✅ Landed | Prevents unconfirmed model hallucinations leaking to homeowners. |
| 6 | Per-user OpenAI spend cap (M4.6, M4.3, M4.8) | **TODO** | Current rate limit is IP-scoped. Add a daily per-contractor cap in `src/lib/vision/classify.ts` and the checklist / nudge modules. |
| 7 | Per-user daily go-between cap (M4.9) | **TODO** | Twilio dial fees. Cap at e.g. 20/day per user before dialing. |
| 8 | Contractor claim-approval queue for ambiguous claims (Q4.0c) | **TODO** | Layered verification is live; the admin-approval fallback for zero-signal claims is scaffolded but no admin UI yet. |
| 9 | `appointment_replacements` and `cv_labels` INSERT/UPDATE RLS policies | **TODO** | Service role bypasses RLS today; explicit `USING (false)` for authenticated writes would document intent. |
| 10 | Contract-id / appointment-id ownership check on `/api/calls/go-between/start` body | **TODO (quality)** | Currently shape-validated only. Not a security hole (nuisance-call defense already blocks the caller), but pollutes analytics. |
| 11 | Twilio webhook signature verification on the go-between callback paths | **Reused from M3.1** | Verify M3.1's `twilioSig.ts` middleware covers the new webhook query strings. |

### 3.D — Monitoring

| # | Item | Status | Notes |
|---|---|---|---|
| 1 | Sentry — cron health for all 4 M4 crons (`no-show-detector`, `recurring-jobs`, `coaching-nudges`, `appointment-reminders`) | **TODO** | Alerts on 5xx or missed runs. |
| 2 | OpenAI spend dashboard — tracked per feature (M4.3 checklist, M4.6 vision, M4.8 nudges) | **TODO** | Tag calls with `feature=` header for post-hoc splitting. |
| 3 | Twilio failed-dial alerts | **TODO** | Both M3.1 and M4.9 rely on Twilio; a 5xx from Twilio should page. |
| 4 | Storage growth alarm on `job-logs` bucket | **TODO** | The M4 build doc's risk item — 100 contractors × 5 jobs/day × 4 photos ≈ 60k photos/month. Alarm at 50 GB. |
| 5 | CV accuracy tracking dashboard | **TODO** | Query `cv_labels` for `confirmed_correct = true` rate over time. Feeds the Q4.6b decision on when to fine-tune. |
| 6 | Watchdog for stale recurring jobs (M4 build-doc risk item) | **TODO** | Alert when an `active` recurring job has zero future appointments — indicates the materialization cron has been missing runs. |
| 7 | Stripe Billing subscription-churn dashboard | **TODO** | M4.1 revenue is the business model. Track MRR, churn, upgrade / downgrade rate. |

### 3.E — Deploy hardening

| # | Item | Status | Notes |
|---|---|---|---|
| 1 | `vercel.json` cron entries verified enabled in dashboard post-deploy | **TODO on next deploy** | 4 cron endpoints: `appointment-reminders`, `recurring-jobs`, `coaching-nudges`, `no-show-detector`. |
| 2 | All M4 env vars pushed to Vercel Production (not just Preview) | **TODO on next deploy** | Full list in "Configuration items needed before launch" table + Part 3.A/B env callouts. |
| 3 | Staging environment with real Twilio number for M4.9 QA | **TODO** | Local dev can't test M4.9 without ngrok; staging with a public URL unblocks it. |
| 4 | Ngrok tunnel for local Twilio testing documented in team README | **TODO (nice-to-have)** | Alternative to staging for M4.9 debugging. |

---

## Source-vision-to-feature anchor map

For SG Dietz's audit — every M4 feature points at a vision-doc paragraph:

| Vision paragraph | Feature | Code |
|---|---|---|
| ¶9 — *"scraping the internet"* | M4.0a CSLB + M4.0b SerpAPI | `src/lib/contractors/sources/*` |
| ¶15 — *"6 will manage the in-person meetings as the go-between"* | M4.9 | `app/api/calls/go-between/start/route.ts`, `src/lib/intent/orchestrator.ts` (handleGoBetweenMode) |
| ¶24 — *"can find them new laborers and subcontractors"* | M4.2 crew marketplace | `src/lib/crew/*` |
| ¶24 — *"rarely forget a tool or the right materials"* | M4.3 checklist | `src/lib/appointments/checklist.ts` |
| ¶24-25 — *"they will pay a subscription"* | M4.1 Stripe Billing | `src/lib/billing/*` |
| ¶27 — *"6 identifies which plants are weeds and which are flowers"* | M4.6 CV labeling | `src/lib/vision/*` |
| ¶28 — *"6 will always be positive and encouraging"* | M4.8 coaching nudges | `src/lib/coaching/*` |
| ¶31 — *"every task in a job will be documented multiple times per day"* | M4.5 photo/video log | `src/lib/jobLogs/*` |
| ¶33 — *"autopilot ... grass mowed, weeds pulled, gutters cleaned"* | M4.7 recurring jobs | `src/lib/recurring/*` |
| ¶33 — *"if contractors don't show, 6 will get contractors that do"* | M4.4 dispatcher | `src/lib/appointments/dispatch.ts` |

M4.0c and M4.0d are operational (not vision-anchored) — they're the foundation the vision-anchored features run on top of.

---

## Sign-off

M4 is code-complete on `main` (4 M4 feature commits + 1 post-review blocker fix-up + 1 quality-item fix-up pending Bert's review). All 8 M4 migrations applied. Typecheck green.

**Before contractors start subscribing with real money:** complete Part 3.A items 1 + 2 + 6 (Stripe products + webhook + Twilio SHAKEN) and Part 3.B items 1 + 3 (contractor ToS + recording consent).

**Before homeowners depend on the autopilot for a full season:** complete Part 3.C items 6 + 8 (per-contractor spend caps + claim-approval queue) and Part 3.D items 1 + 6 (Sentry cron alerts + stale-recurring-job watchdog).

**Before flipping M4.6 CV on in production:** run the Q4.6b spike (10 hand-verified photos), Part 3.B item 4 (data-consent language), and Part 3.D item 5 (accuracy tracking).

**Before public launch:** run the M4 exit-gate rehearsal end-to-end per [M4-EXIT-GATE-REHEARSAL.md](M4-EXIT-GATE-REHEARSAL.md) and tag the passing commit `m4-exit-gate-passed`.

Everything else is iteration on top of a green codebase.
