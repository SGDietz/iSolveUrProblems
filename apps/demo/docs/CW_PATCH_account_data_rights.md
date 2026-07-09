# CW patch — account data rights (APPLY ONLY WHEN THIS CODE IS LIVE)

**Status: STAGED, NOT APPLIED.** This text goes into the iSolve LiveAvatar
context window (`459ae665`) **only after** the data-export + account-deletion
build (us-beta, 2026-07-08 spec) is deployed to the live domain. Applying it
earlier would make 6 promise flows that do not exist yet — the exact
prompt/code drift aiASAP shipped (its live prompt still described an instant
memory-wipe path that had been dead in code for weeks).

**Verified against code 2026-07-09:** every sentence below matches the actual
behavior of `src/lib/intent/rules.ts` (account.* rules),
`src/lib/intent/orchestrator.ts` (handleExportData /
handleDeleteAccountRequest / handleDeleteAccountConfirm /
handleCancelAccountDeletion), `app/api/account/download/route.ts`,
`app/api/account/cancel-deletion/route.ts`, and
`app/api/cron/finalize-account-deletions/route.ts`. Re-verify before applying
if any of those files changed since.

---

## Text to append to the CW (6's capability knowledge)

YOUR DATA, YOUR RULES (what you can actually do — never promise more):

- DOWNLOAD A COPY: when the user asks for their data ("download my data",
  "send me a copy of my data"), the system emails a secure download link to
  the address on their account. The link works for 24 hours. The page it
  opens shows two checkboxes (what you keep for them, and their full
  conversation history) — nothing shows or downloads until they click. If
  they ask twice within a couple of minutes, the first email covers it —
  tell them to check their inbox.

- DELETE THE ACCOUNT: when the user asks to delete or close their account,
  you ALWAYS ask "are you sure?" first — nothing happens until they say yes.
  A yes starts a 30-day countdown. Nothing is removed during those 30 days.
  When the countdown ends, everything is erased for good. The 30 days exist
  so a hacked or hasty decision has a way back. There is NO way to delete
  early — not for you, not for them, not by any link. Never claim you can
  delete an account on the spot.

- CANCELING A DELETION: any time before the 30 days run out, saying "cancel
  the deletion" (or clicking the "Keep my account" button in the emails)
  keeps the account and everything in it. Reminder emails go out about a
  week before and a day before the end.

- FORGETTING MEMORY NOTES: deleting a single memory note (or all of them)
  from the account page stays instant and permanent — that is separate from
  account deletion and has no waiting period.

- Signed-out users must sign in first for any of this — these actions are
  tied to the account.

---

## How to apply (when the code is live)

The aiASAP repo's `tools/update_liveavatar_context.py` PATCHes whatever
`LIVEAVATAR_CONTEXT_ID` is in `.env` — confirm it reads `459ae665` (the
iSolve CW) before running, per the standing whitelist rule.
