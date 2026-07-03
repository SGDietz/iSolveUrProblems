# M4 — Exit-Gate Rehearsal

> Date drafted: 2026-07-03
> Audience: **Bert** (operator) + **SG Dietz** (test driver)
> Companion: [M4-BUILD-ORDER.md](M4-BUILD-ORDER.md), [ROADMAP.md](ROADMAP.md)
> Source vision: `20260326-iSolveUrProblems-LASTB4MOVE2DROPBOX.docx`
> Status: **Ready to run** — all M4 features (M4.0 → M4.9) are code-complete on `main`.

This document walks Bert + SG Dietz through the **M4 exit-gate scenario** end-to-end in one lab day. It compresses the 24-week "mow every Tuesday from May through October" arc into a compressed test session by manually triggering the crons and time-warping appointments in Supabase.

If every step passes without homeowner re-engagement, **M4 has hit its Definition of Done** and we're clear to move to M5.

---

## TL;DR — the M4 exit-gate story

Quoting the build doc:

> A homeowner asks 6 *"keep my lawn mowed every Tuesday from May through October"* → 6 picks a contractor → contractor accepts subscription job in their portal → every week the appointment fires, 6 confirms the contractor is showing up, the worker takes the required photo on arrival + completion, and 6 emails the homeowner the photo log — for the whole season, with zero homeowner re-engagement.

We replay this arc in **9 steps** across two lab sessions:

1. **Setup phase** (steps 0–2) — homeowner + contractor accounts, contractor subscribes to Gold, one-time seeding.
2. **Rehearsal phase** (steps 3–8) — the recurring job runs, arrival / completion photos get logged + AI-labeled, one week gets a forced no-show → M4.4 dispatcher recovers, coaching nudge fires for the streak.
3. **Ancillary check** (step 9) — go-between mode is triggered on-site.

Each step maps 1:1 to a Definition-of-Done checkbox at the bottom.

---

## What's Already in Place

| # | Feature | Status | Commit |
|---|---|---|---|
| M4.0a | License-board contractor adapter (CSLB) | ✅ Shipped | `7156ccb` |
| M4.0b | SerpAPI adapter | ✅ Shipped | `7156ccb` |
| M4.0c | Contractor self-signup + profile claim | ✅ Shipped | `1bd6fea` |
| M4.0d | Contractor dashboard shell | ✅ Shipped | `1bd6fea` |
| M4.1 | Tiered subscriptions (Stripe Billing) | ✅ Shipped | `f542d1c` |
| M4.2 | Crew marketplace | ✅ Shipped | `ddc7508` |
| M4.3 | Tool/material checklist agent | ✅ Shipped | `21112f4` |
| M4.4 | Backup / no-show dispatcher | ✅ Shipped | `ce0f451` |
| M4.5 | Daily photo/video job log | ✅ Shipped | `79ab629` |
| M4.6 | Worker-in-the-loop CV (v1) | ✅ Shipped | `d2aa0ef` |
| M4.7 | Recurring / autopilot scheduler | ✅ Shipped | `ce83f6f` |
| M4.8 | Positive-coaching nudges | ✅ Shipped | `8eae5cd` |
| M4.9 | In-person go-between mode | ✅ Shipped | `46f6dca` |

---

## Prerequisites — Bert runs these once before Session 1

### 1. Supabase migrations applied

Apply the full M4 migration set on top of M3:

```
apps/demo/supabase/migrations/20260615_m4_contractor_portal.sql        — M4.0c/d
apps/demo/supabase/migrations/20260615_m4_recurring_jobs.sql           — M4.7
apps/demo/supabase/migrations/20260629_m4_appointment_checklists.sql   — M4.3
apps/demo/supabase/migrations/20260630_m4_coaching_nudges.sql          — M4.8
apps/demo/supabase/migrations/20260630_m4_job_logs.sql                 — M4.5
apps/demo/supabase/migrations/20260701_m4_crew_marketplace.sql         — M4.2
apps/demo/supabase/migrations/20260703_m4_appointment_no_show.sql      — M4.4
apps/demo/supabase/migrations/20260704_m4_cv_labels.sql                — M4.6
```

Sanity check in SQL editor:

```sql
select count(*) from public.recurring_jobs;             -- 0
select count(*) from public.appointment_checklists;     -- 0
select count(*) from public.job_log_entries;            -- 0
select count(*) from public.appointment_replacements;   -- 0
select count(*) from public.cv_labels;                  -- 0
```

If any table is missing, the corresponding migration didn't apply — re-run it.

### 2. Env vars set (Vercel + local `.env.local`)

Required for the full rehearsal:

| Var | Feature it powers | Fallback if unset |
|---|---|---|
| `OPENAI_API_KEY` | M4.3 checklist, M4.6 CV, M4.8 nudges | Feature no-ops |
| `TWILIO_ACCOUNT_SID` / `TWILIO_AUTH_TOKEN` / `TWILIO_VOICE_FROM_NUMBER` / `APP_PUBLIC_BASE_URL` | M4.9 go-between | Route returns 503 |
| `STRIPE_SECRET_KEY` / `STRIPE_BILLING_WEBHOOK_SECRET` / `STRIPE_PRICE_BRONZE` / `STRIPE_PRICE_SILVER` / `STRIPE_PRICE_GOLD` | M4.1 subscriptions | Route returns 503 |
| `STRIPE_CONNECT_WEBHOOK_SECRET` / `STRIPE_CONNECT_RETURN_URL` | Contractor Connect onboarding | Route returns 503 |
| `RESEND_API_KEY` / `NOTIFICATION_FROM_EMAIL` | M4.4 urgent dispatch email, M4.5 completion summary, M4.8 nudges | Notifications no-op (safe) |
| `CRON_SECRET` | All crons | Crons return 503 |
| `ADMIN_SECRET` | M4.0a CSLB sync + contractor seed | Sync/seed 503 |
| `SUPABASE_URL` / `SUPABASE_SERVICE_ROLE_KEY` | Everything | App won't boot |

### 3. Seed contractors + create a real California licensed row

For the rehearsal you need **at least one contractor** that a signup can claim. Two paths:

**Path A — mock seed (fast, doesn't test M4.0a):**

```powershell
Invoke-RestMethod `
  -Uri "http://localhost:3001/api/admin/contractors/seed" `
  -Method POST `
  -Headers @{ "Authorization" = "Bearer $env:ADMIN_SECRET" } `
  -ContentType "application/json" `
  -Body '{"categories":["landscaper"],"per_category":10}'
```

Then in SQL, pretend one row is CSLB-verified so the claim flow's license-number check has something to match:

```sql
update public.contractors
set license_number   = 'CA-1234567',
    license_status   = 'active',
    license_expires_at = '2027-12-31'
where categories @> array['landscaper']
order by rating_avg desc nulls last
limit 1
returning id, name;
```

Note the returned `id` — you'll paste it into the claim form in Step 2.

**Path B — real CSLB sync (tests M4.0a end-to-end):**

```powershell
Invoke-RestMethod `
  -Uri "http://localhost:3001/api/admin/contractors/sync" `
  -Method POST `
  -Headers @{ "Authorization" = "Bearer $env:ADMIN_SECRET" } `
  -ContentType "application/json" `
  -Body '{"state":"CA","batch_size":25,"category":"landscaper"}'
```

Wait for it to return `{ ok: true, upserted: N }`, then verify:

```sql
select id, name, license_number, license_status
from public.contractors
where license_status = 'active' and license_number is not null
limit 5;
```

### 4. Stripe Billing products created

In the Stripe Dashboard, create three recurring products (monthly, USD):
- Bronze — $29
- Silver — $79
- Gold — $199

Copy each Price ID into env as `STRIPE_PRICE_BRONZE` / `STRIPE_PRICE_SILVER` / `STRIPE_PRICE_GOLD`. Wire the billing webhook endpoint to `/api/webhooks/stripe-billing` and subscribe to `customer.subscription.{created,updated,deleted}`, `invoice.paid`, `invoice.payment_failed`.

### 5. Dev server running

```
pnpm dev --filter demo
```

Wait for *"ready on http://localhost:3001"*.

---

## Session 1 — Setup phase (steps 0–2)

### Step 0 — Verify the preflight

**Bert runs:**

```powershell
# All prereq tables present?
# Point psql at your Supabase Postgres connection string — grab it from
# Supabase Dashboard → Project Settings → Database → Connection string.
psql "$env:DATABASE_URL" -c "select table_name from information_schema.tables where table_schema='public' and table_name in ('recurring_jobs','appointment_checklists','job_log_entries','appointment_replacements','cv_labels','coaching_nudges_sent','crew_requests','contractor_billing_subscriptions') order by table_name;"

# Cron endpoints respond
foreach ($p in @("appointment-reminders","recurring-jobs","coaching-nudges","no-show-detector")) {
  Invoke-RestMethod -Uri "http://localhost:3001/api/cron/$p" -Headers @{ Authorization = "Bearer $env:CRON_SECRET" }
}
```

Every cron should return JSON — not a 401 (bad `CRON_SECRET`) or 500.

### Step 1 — Homeowner finds + books the contractor (M3 recap)

**SG Dietz opens** `http://localhost:3001/en`, clicks **Start**.

**Say:** *"Find me a landscaper near Austin."*

- ✅ Contractors drawer populates
- ✅ Take note of the top pick's **name** and **contractor id** — copy the id from Network → response → `variant.hits[0].id`. You'll re-use it below.

**Say:** *"Book that one."*

- ✅ Pick-result panel appears
- ✅ In SQL: `select id, contractor_id, status from public.contracts order by created_at desc limit 1;` — one row, freshly created

If Step 1 fails, this isn't an M4 problem — go back to the M3 test drive. M4 assumes a functioning M2/M3.

### Step 2 — Contractor claims profile + subscribes to Gold

**Sign out** as the homeowner. Open a private window.

**Navigate to** `http://localhost:3001/en/for-contractors` and sign in with a **different email** (the "contractor" identity).

- ✅ You land on the profile-claim form
- ✅ Enter the CSLB license number from prereqs step 3 (e.g. `CA-1234567`) → claim succeeds
- ✅ You land on `/en/contractor/dashboard`
- ✅ The header shows the contractor's name
- ✅ The **"Pending job invitations"** section shows the contract you just created in Step 1

**Click "Start Connect onboarding"** and complete the Stripe Express onboarding flow (Stripe's test data:
`4242 4242 4242 4242`, any future date, any CVC, any bank details).

- ✅ Return to dashboard → "Payout ready" green badge appears (may need one dashboard reload for the webhook)

**Scroll to the SubscriptionPanel**, click **"Upgrade to Gold"**. Complete the Stripe Checkout with `4242 4242 4242 4242`.

- ✅ Return to dashboard → tier badge reads **Gold**
- ✅ In SQL: `select tier, status from public.contractor_billing_subscriptions where contractor_id = '<pasted id>';` returns `('gold','active')`

**Exit criteria for setup phase:**
- Contractor row has `claimed_by_user_id` set, `stripe_connect_charges_enabled=true`, and an active Gold subscription.

---

## Session 2 — Rehearsal phase (steps 3–8)

### Step 3 — Homeowner asks for the recurring mowing job (M4.7)

**Sign back in as the homeowner** and click **Start**.

**Say:** *"Keep my lawn mowed every Tuesday from May through October."*

- ✅ Network fires `POST /api/transcripts/append`. Response: `classification.kind: "schedule_recurring"`, `slots.recurring.schedule` is populated
- ✅ **Recurring-job panel** slides in with the cadence readback ("Every Tuesday at 10:00 AM, May through October") and the next 3 instances
- ✅ 6 says something like: *"You're on autopilot — every Tuesday at 10 AM from now through October. First one lands next Tuesday. Say 'pause the lawn mowing' any time to stop."*
- ✅ In SQL: `select id, title, status, schedule from public.recurring_jobs order by created_at desc limit 1;` — one row, status `active`

**Note the `recurring_job_id`** — you'll use it to time-warp.

### Step 4 — Force the cron to materialize the first 7 days (M4.7 cron)

**Bert runs:**

```powershell
Invoke-RestMethod `
  -Uri "http://localhost:3001/api/cron/recurring-jobs" `
  -Headers @{ Authorization = "Bearer $env:CRON_SECRET" }
```

- ✅ Response body: `{ ran_at: ..., materialized: N }` with N ≥ 1
- ✅ In SQL: `select id, scheduled_at, status from public.appointments where context->>'source' = 'recurring' order by scheduled_at limit 3;` — the next 1–3 Tuesday-10am appointments

**Take the id of the first appointment** — call it `$APPT`. Time-warp it to 25h from now so the 24h reminder is still in the future:

```sql
update public.appointments
set scheduled_at = now() + interval '25 hours'
where id = '<APPT>';
```

### Step 5 — Fire the 24h reminder + generate the checklist (M4.3)

**Bert runs:**

```powershell
Invoke-RestMethod `
  -Uri "http://localhost:3001/api/cron/appointment-reminders" `
  -Headers @{ Authorization = "Bearer $env:CRON_SECRET" }
```

- ✅ Response shows the appointment being reminded
- ✅ In SQL: `select reminder_24h_sent_at, checklist_notified_at from public.appointments where id = '<APPT>';` — both populated
- ✅ In SQL: `select items from public.appointment_checklists where appointment_id = '<APPT>';` — a JSON array of tools + materials + confirmations

**Contractor dashboard reload** should now show a **ChecklistTile** for this appointment. The contractor ticks off at least one item.

- ✅ In SQL: the ticked item now has `checked_at` and `checked_by_user_id` populated

### Step 6 — Contractor arrives, logs photos, AI labels one (M4.5 + M4.6)

Time-warp the appointment forward again so it's "now" (contractor is on-site):

```sql
update public.appointments
set scheduled_at = now() - interval '5 minutes'
where id = '<APPT>';
```

**Contractor navigates** to `/en/contractor/jobs/<APPT>/log`.

- ✅ Three phase buttons render (Arrival / In progress / Completion)
- ✅ Tap **Arrival** → device camera opens → take a photo of a plant / lawn / anything green
- ✅ Photo appears in the timeline within 1–2 seconds
- ✅ In SQL: `select id, kind, phase, ai_caption from public.job_log_entries where appointment_id = '<APPT>';` — one row, kind=`photo`, phase=`arrival`
- ✅ **M4.4 side-effect check:** `select contractor_confirmed_at from public.appointments where id = '<APPT>';` — populated (the photo upload flipped it)

**Under the arrival photo**, tap **"Identify with 6"** (M4.6 gold-tier chip).

- ✅ Chip transitions: idle → classifying (3–5s spinner) → predicted
- ✅ Predicted label is a plausible plant / weed / lawn identifier
- ✅ Tap **Yes** — chip shows **Confirmed: <label>** with a checkmark
- ✅ In SQL: `select predicted_label, confirmed_label, confirmed_correct from public.cv_labels;` — one row, confirmed_correct=`true`

**Now the completion photo.** Take a second photo, tap **Completion** phase. Tap **"Identify with 6"** on it, then **No** → type `dandelion` → **Save**.

- ✅ In SQL: `select confirmed_label, confirmed_correct from public.cv_labels order by created_at desc limit 1;` — `('dandelion', false)`

**Q4.6b spike gate:** Take 10 varied photos, run identify on each, hand-verify how many predictions the confirmed answer matches. If ≥ 7/10, M4.6 v1 ships. If < 7/10, defer per the M4 build doc's acceptable-partial-outcome clause.

### Step 7 — Force a no-show scenario next week (M4.4)

Materialize the **second** week's appointment, then time-warp it into the "no-show window" (past `scheduled_at` + 30min grace, contractor never confirmed):

```sql
-- Grab the 2nd upcoming recurring appointment
select id, scheduled_at from public.appointments
where context->>'source' = 'recurring'
  and status in ('scheduled','rescheduled')
  and contractor_confirmed_at is null
order by scheduled_at
limit 1;

-- Time-warp it to 45 minutes ago (past grace, no confirmation)
update public.appointments
set scheduled_at = now() - interval '45 minutes'
where id = '<APPT_2>';
```

**Bert runs:**

```powershell
Invoke-RestMethod `
  -Uri "http://localhost:3001/api/cron/no-show-detector" `
  -Headers @{ Authorization = "Bearer $env:CRON_SECRET" }
```

- ✅ Response body: `results` array includes the appointment id with a dispatch result
- ✅ In SQL: `select status, no_show_detected_at from public.appointments where id = '<APPT_2>';` — status is `no_show`, timestamp populated
- ✅ In SQL: `select trigger, invited_count from public.appointment_replacements where original_appointment_id = '<APPT_2>';` — one row, `trigger='cron_grace_expired'`, `invited_count` ≥ 1 (if other same-day landscapers are seeded with claimed accounts + emails)
- ✅ Any candidate landscapers with emails receive the `contractor.urgent_dispatch.v1` email

**Homeowner-initiated variant.** Take a fresh 3rd-week appointment, sign in as the homeowner, and say:

*"They didn't show up."*

- ✅ Network response: `classification.kind: "report_no_show"`
- ✅ Appointment card panel with header "Dispatching a substitute" appears
- ✅ Same row-level side effects as the cron variant

### Step 8 — Coaching nudge fires for the streak (M4.8)

Force the coaching-nudge cron:

```powershell
Invoke-RestMethod `
  -Uri "http://localhost:3001/api/cron/coaching-nudges" `
  -Headers @{ Authorization = "Bearer $env:CRON_SECRET" }
```

- ✅ Response mentions the contractor id at least once
- ✅ In SQL: `select event_kind, subject, dedup_key from public.coaching_nudges_sent where contractor_id = '<contractor_id>' order by created_at desc limit 5;` — at least one row (probably an on-time or first-review event; content varies with test data)
- ✅ Run the cron **a second time immediately** — no new rows should appear (dedup gate holds)

---

## Session 3 — Ancillary check (step 9)

### Step 9 — Go-between mode (M4.9)

**Sign in as the homeowner** on a phone. Beside you, the contractor is (or is pretending to be) physically present.

**Say:** *"6, get on the phone with me while the landscaper's here."*

- ✅ Network: `classification.kind: "go_between_mode"`
- ✅ CallPanel opens with the **"Go-between"** badge in the header and "In-person go-between" title
- ✅ Twilio dials both the homeowner and the contractor
- ✅ In SQL: `select context->>'mode' as mode, status from public.calls order by created_at desc limit 1;` — `mode='go_between'`, status transitions dialing → in_progress
- ✅ Transcript lines appear as either party speaks
- ✅ Say "hey 6, does this quote look fair?" — 6 responds via Twilio Conference Announce audible to both parties

If Twilio isn't wired in the dev environment, the route returns 503 — mark this step as **deferred to staging** and continue.

---

## Definition of Done — Exit checklist

Every checkbox below should be checked by the end of Session 3.

- [ ] **M4.0** — Contractor self-signed-up, claimed a licensed profile via license-number cross-check, completed Stripe Connect onboarding without admin intervention _(Step 2)_
- [ ] **M4.1** — Contractor subscribed to a paid tier (Gold) and tier gating works: photo log unlocked (bronze+), recurring jobs unlocked (silver+), CV labeling unlocked (gold) _(Steps 2, 6)_
- [ ] **M4.7** — Homeowner asked for a recurring job via voice; recurring_jobs row created; cron materialized ≥ 1 appointment; each instance fires the normal reminder + confirmation pipeline _(Steps 3, 4, 5)_
- [ ] **M4.3** — Pre-departure checklist was generated for the first materialized appointment; contractor can tick items off _(Step 5)_
- [ ] **M4.5** — Contractor captured arrival + completion photos; homeowner-visible timeline populated _(Step 6)_
- [ ] **M4.4** — Cron detected a no-show within 30 min of scheduled_at + grace; homeowner voice-report path also dispatched a same-day backup; audit row present in appointment_replacements _(Step 7)_
- [ ] **M4.6** — Predicted labels came back within 5s; worker confirmation + correction both persist to cv_labels; Q4.6b spike hit ≥ 70% test-set accuracy (or the feature was deferred to M5 with the spike documented in this doc) _(Step 6)_
- [ ] **M4.8** — Coaching nudge cron produced ≥ 1 LLM-composed nudge for ≥ 3 event types across a synthetic dataset; dedup holds on second run _(Step 8)_
- [ ] **M4.9** — Go-between mode dialed both phones into a shared conference; the badge rendered; 6 was addressable by both parties from a single room _(Step 9 — deferrable to staging)_

**Zero-re-engagement check (the big one):** After Step 3, the homeowner did **not** touch the app again through Step 8. All progression — appointment materialization, checklist, arrival confirmation, no-show detection, backup dispatch, coaching nudges — was driven by cron + contractor action.

If that's true and every checkbox is checked, **M4 is done.**

---

## What's mocked vs. what's real

| Piece | In this rehearsal | In production |
|---|---|---|
| Time between recurring instances | SQL time-warp updates | 7 days elapsed via `pg_now()` |
| Weekly cron cadence | Manual POST | Vercel cron (defined in `vercel.json`) |
| Contractor's arrival | Photo upload + optional SQL confirm | Actual arrival at the property |
| Stripe subscription payments | Stripe test-mode card | Live card + real charges |
| CV weed-vs-flower photos | Whatever is handy | Real garden work |
| Twilio 3-way conference (M4.9) | Real Twilio in staging; skipped locally | Real Twilio |

The rehearsal deliberately avoids anything that would take the ops team longer than 1 lab-day. The compression is safe because every M4 feature was built to be idempotent + resumable, so a "week later" state is indistinguishable from a "1 SQL update later" state.

---

## Troubleshooting

### "Cron endpoints return 401"
`CRON_SECRET` env var is missing or wrong. Set it in `.env.local` and restart the dev server. The Authorization header must be exactly `Bearer <CRON_SECRET>`.

### "The recurring job cron says materialized=0"
`recurring_jobs.status` is probably `paused` or `ended`. Check `select status, active_from, active_until from public.recurring_jobs`. If `active_from` is > now(), the cron correctly waits.

### "The no-show detector says considered=0"
The partial index on `appointments` filters for `contractor_confirmed_at IS NULL`. Did the arrival photo upload already flip it? Check `contractor_confirmed_at`. To force a no-show scenario, use a **fresh** materialized appointment that never had a photo uploaded.

### "The CV chip stays gated"
The contractor's active tier isn't gold. Check: `select tier, status from contractor_billing_subscriptions where contractor_id = '<id>' and status = 'active';`. The chip only fires for gold; that's the intended gate per Q4.1a.

### "Coaching nudge cron returns 0 sent"
The event catalog needs data to fire on. If the test contractor has no completed jobs, no reviews, and no on-time streak in the dataset, there's nothing to nudge on. To seed a synthetic event, run:

```sql
-- Simulate an on-time-streak-of-3
update public.appointments
set status = 'completed', contractor_confirmed_at = scheduled_at + interval '2 minutes'
where contractor_id = '<id>'
  and scheduled_at < now()
limit 3;
```

Then re-run the cron.

### "Twilio dial fails in go-between mode"
Either `TWILIO_VOICE_FROM_NUMBER` isn't a verified Twilio number or `APP_PUBLIC_BASE_URL` is `http://localhost:3001` (Twilio requires publicly reachable HTTPS for TwiML callbacks). Ngrok the app or defer M4.9 to staging.

---

## After the Rehearsal

If **every checkbox above** is checked, tag the passing commit so we can trace back to this exact code state if a regression ever surfaces:

```powershell
git tag -a m4-exit-gate-passed -m "M4 exit-gate rehearsal passed $(Get-Date -Format o) by $env:USERNAME"
git push origin m4-exit-gate-passed
```

Then:

1. Push `main` to production (`git push origin main`)
2. Open the M5-BUILD-ORDER doc (draft-only; not yet written) and start scoping
3. Notify Bert + SG Dietz that M4 is done

If **any checkbox failed**:

1. Log the failure in this doc's `## Known failures` section (append at the bottom)
2. Root-cause and file a fix commit on `main`
3. Re-run only the failed step from scratch
4. Repeat until clean

---

## Known failures

_(Fill in as the rehearsal runs. Each entry: step id, symptom, root cause, fix commit.)_
