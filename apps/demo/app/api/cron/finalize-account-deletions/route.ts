import { NextResponse, type NextRequest } from "next/server";
import { CRON_SECRET } from "../../secrets";
import { verifyAdminBearer } from "../../../../src/lib/apiRouteSecurity";
import {
  decideDeletionAction,
  getAccountDeletion,
  listPendingDeletions,
  markReminderSent,
  purgeDateText,
} from "../../../../src/lib/account/deletionSchedule";
import { hasOpenDispute, purgeUserAccount } from "../../../../src/lib/account/purge";
import { signActionToken } from "../../../../src/lib/account/tokens";
import { send } from "../../../../src/lib/notifications";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * Daily finalizer for 30-day account deletions — the ONLY place in the
 * whole app that can purge an account, and only after purge_at has
 * passed on its own. No user-reachable route or link finalizes early
 * (src/lib/account/tokens.ts documents why).
 *
 * Per pending schedule:
 *   - >7 days left  → nothing
 *   - ≤7 days left  → "one week left" email (once)
 *   - ≤1 day left   → "last chance" email (once)
 *   - clock done    → purge + "all done" email — unless a live dispute
 *     defers it (Privacy §12 keeps records to resolve an open dispute;
 *     the purge runs on a later pass once it closes)
 *
 * Double-send guard is two-layer: the reminder_*_sent metadata flags
 * (checked before, set only AFTER a successful send so a failed pass
 * retries) + deterministic notifications_sent idempotency keys (so a
 * crash between send and mark can't double-email either).
 *
 * Deletion lifecycle emails send WITHOUT userId on purpose: they're
 * legally-required transactional notices that must reach the user even
 * if they've unsubscribed from email (the consent gate in send() only
 * runs when userId is present). The user id rides in `context` for the
 * audit row instead.
 */

function bad(msg: string, status = 400) {
  return NextResponse.json({ error: msg }, { status });
}

const TIME_BUDGET_MS = 45_000; // stay inside maxDuration; the rest waits a day

function appOrigin(): string {
  return (
    process.env.PUBLIC_APP_ORIGIN?.trim() || "https://www.isolveurproblems.ai"
  ).replace(/\/$/, "");
}

function cancelUrl(userId: string): string {
  const token = signActionToken("cancel", userId);
  return `${appOrigin()}/api/account/cancel-deletion?token=${encodeURIComponent(token)}`;
}

async function handle(request: NextRequest) {
  if (!CRON_SECRET) return bad("CRON_SECRET not configured", 503);
  if (!verifyAdminBearer(request.headers.get("authorization"), CRON_SECRET).ok) {
    return bad("unauthorized", 401);
  }

  const started = Date.now();
  const pending = await listPendingDeletions();
  const actions: string[] = [];
  const errors: string[] = [];
  let deferred = 0;

  for (const p of pending) {
    if (Date.now() - started > TIME_BUDGET_MS) {
      actions.push("time-budget reached — remaining schedules wait for tomorrow's run");
      break;
    }
    const action = decideDeletionAction(p.schedule, Date.now());
    if (action === "wait") continue;

    if (action === "remind_week" || action === "remind_day") {
      if (!p.email) {
        errors.push(`${p.userId}: no email on file for ${action}`);
        continue;
      }
      const stage = action === "remind_week" ? "week" : "day";
      const result = await send({
        channel: "email",
        recipient: p.email,
        templateId: `account.deletion.${stage}.v1`,
        data: {
          cancelUrl: cancelUrl(p.userId),
          purgeDate: purgeDateText(p.schedule.purge_at),
        },
        idempotencyKey: `account-deletion:${stage}:${p.userId}:${p.schedule.purge_at}`,
        context: { user_id: p.userId, kind: "account-deletion-reminder" },
      });
      if (result.ok) {
        await markReminderSent(p.userId, stage);
        actions.push(`${p.userId}: sent ${stage} reminder`);
      } else {
        errors.push(`${p.userId}: ${stage} reminder failed (${result.error})`);
      }
      continue;
    }

    // action === "purge"
    if (await hasOpenDispute(p.userId)) {
      deferred++;
      actions.push(`${p.userId}: purge deferred — open dispute (Privacy §12)`);
      continue;
    }
    // Last-moment re-read: the pending list was snapshotted at the top of
    // this run, and a cancel (voice or email button) may have landed
    // since. A purge that races a successful cancel would be the exact
    // betrayal the cancel page just promised against — re-verify the
    // schedule still exists and still says purge, right now.
    const fresh = await getAccountDeletion(p.userId);
    if (!fresh || decideDeletionAction(fresh, Date.now()) !== "purge") {
      actions.push(`${p.userId}: purge skipped — schedule canceled or changed mid-run`);
      continue;
    }
    const purge = await purgeUserAccount(p.userId);
    if (!purge.ok) {
      errors.push(
        `${p.userId}: purge incomplete (${JSON.stringify(purge.steps)}) — retrying tomorrow`,
      );
      continue;
    }
    actions.push(`${p.userId}: purged`);
    if (p.email) {
      // One final audit row (recipient only, user is gone) — the proof
      // the completion notice went out.
      const done = await send({
        channel: "email",
        recipient: p.email,
        templateId: "account.deletion.done.v1",
        data: {},
        idempotencyKey: `account-deletion:done:${p.userId}`,
        context: { user_id: p.userId, kind: "account-deletion-done" },
      });
      if (!done.ok) errors.push(`${p.userId}: done email failed (${done.error})`);
    }
  }

  console.log(
    `[finalize-account-deletions] pending=${pending.length} actions=${actions.length} deferred=${deferred} errors=${errors.length}`,
  );
  return NextResponse.json({
    ok: true,
    pending: pending.length,
    deferred,
    actions,
    errors,
  });
}

export const GET = handle;
export const POST = handle;
