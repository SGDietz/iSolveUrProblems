import type { NotificationTemplate, EmailRendered } from "../types";

/**
 * Account-deletion lifecycle emails (factory + named exports, the
 * appointment-reminder.ts model). Four stages:
 *
 *   scheduled — day 0, right after the user confirms by voice
 *   week      — ~7 days before the purge (sent by the daily cron)
 *   day       — ~1 day before the purge (sent by the daily cron)
 *   done      — after the purge completed
 *
 * Every pre-purge email carries ONE button: "Keep my account" — the
 * signed cancel link. There is deliberately NO "delete now" button or
 * link anywhere in this family: the 30-day clock finishes on its own,
 * cron-only (G locked 2026-07-08 — "no early delete ever correct").
 */

export type AccountDeletionData = {
  /** Signed /api/account/cancel-deletion link. Absent only on "done". */
  cancelUrl?: string;
  /** Friendly purge date, e.g. "August 7, 2026". Absent only on "done". */
  purgeDate?: string;
};

type Stage = "scheduled" | "week" | "day" | "done";

const COPY: Record<
  Stage,
  { kicker: string; heading: string; subject: string; body: (d: AccountDeletionData) => string }
> = {
  scheduled: {
    kicker: "Account",
    heading: "Got it — closing in 30 days",
    subject: "Your iSolveUrProblems account will close in 30 days",
    body: (d) =>
      `You asked me to delete your account, so the 30-day clock has started. Everything gets erased for good on <b>${d.purgeDate ?? "the scheduled date"}</b>.<br><br>Why the wait? If someone got into your account, or you simply change your mind, those 30 days are your way back — one click below and everything stays exactly as it is.`,
  },
  week: {
    kicker: "Account",
    heading: "One week left",
    subject: "1 week until your iSolveUrProblems account is deleted",
    body: (d) =>
      `Just a heads-up from me: your account and everything in it gets erased for good on <b>${d.purgeDate ?? "the scheduled date"}</b>. If you want to keep it, one click below is all it takes.`,
  },
  day: {
    kicker: "Account",
    heading: "Last chance",
    subject: "Your iSolveUrProblems account is deleted tomorrow",
    body: (d) =>
      `Tomorrow (<b>${d.purgeDate ?? "the scheduled date"}</b>) your account and everything in it gets erased for good. This is the last note I'll send before it happens. Want to keep it? One click below.`,
  },
  done: {
    kicker: "Account",
    heading: "All done",
    subject: "Your iSolveUrProblems account has been deleted",
    body: () =>
      `Your account and your data are gone, like you asked. There's no hidden copy. If you ever want to start fresh, you know where to find me.`,
  },
};

function render(stage: Stage, data: AccountDeletionData): EmailRendered {
  const c = COPY[stage];
  const button = data.cancelUrl
    ? `<p style="margin:24px 0"><a href="${data.cancelUrl}" style="background:#facc15;color:#18181b;padding:12px 20px;border-radius:6px;text-decoration:none;font-weight:600;display:inline-block">Keep my account &rarr;</a></p>`
    : "";
  const buttonText = data.cancelUrl ? `\n\nKeep my account: ${data.cancelUrl}` : "";
  const cancelNote =
    stage === "done"
      ? ""
      : `<p style="font-size:13px;color:#52525b">You can also cancel any time by telling 6: "cancel the deletion." Nothing is removed until the date above.</p>`;
  const cancelNoteText =
    stage === "done"
      ? ""
      : `\n\nYou can also cancel any time by telling 6: "cancel the deletion." Nothing is removed until the date above.`;
  return {
    subject: c.subject,
    html: `<!doctype html>
<html><body style="font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;max-width:560px;margin:24px auto;line-height:1.5;color:#18181b">
  <div style="border-top:4px solid #facc15;padding-top:12px">
    <div style="font-size:11px;letter-spacing:1.5px;text-transform:uppercase;color:#52525b">iSolveUrProblems &middot; ${c.kicker}</div>
    <h2 style="margin:6px 0 0;font-size:22px">${c.heading}</h2>
  </div>
  <p>${c.body(data)}</p>
  ${button}
  ${cancelNote}
  <p>&mdash; 6</p>
</body></html>`,
    text: `${c.heading}\n\n${c
      .body(data)
      .replace(/<br\s*\/?>(\s*)/gi, "\n")
      .replace(/<[^>]+>/g, "")}${buttonText}${cancelNoteText}\n\n— 6`,
  };
}

function buildAccountDeletionTemplate(
  stage: Stage,
): NotificationTemplate<AccountDeletionData> {
  return {
    id: `account.deletion.${stage}.v1`,
    contentType: "transactional",
    renderEmail: (data) => render(stage, data),
  };
}

export const accountDeletionScheduledTemplate = buildAccountDeletionTemplate("scheduled");
export const accountDeletionWeekTemplate = buildAccountDeletionTemplate("week");
export const accountDeletionDayTemplate = buildAccountDeletionTemplate("day");
export const accountDeletionDoneTemplate = buildAccountDeletionTemplate("done");
