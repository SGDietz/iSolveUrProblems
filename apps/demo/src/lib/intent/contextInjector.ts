/**
 * M3.0e — Context injection wrappers.
 *
 * Each function takes a backend result and produces the "context message"
 * we send to HeyGen's brain via `session.message()`. The wrappers are
 * modeled exactly on the proven image-analysis pattern at
 * [LiveAvatarSession.tsx:975-978]: a leading tag tells the brain not to
 * read the wrapper aloud, the body provides the data, and the tail
 * instructs the brain how to narrate it.
 *
 * Keep wrappers SHORT and SPECIFIC. The shorter the wrapper, the less
 * latency between user finishing speaking and the brain producing the
 * spoken result.
 */

import type {
  AppointmentCard,
  CallPayload,
  ComparePayload,
  ContractPayload,
  ContractorCard,
  DisputePayload,
  EstimatePayload,
  PickResultPayload,
  RecommendationCard,
  RecurringJobPayload,
  SummaryPayload,
} from "../assistantSurface";

function ratingPart(c: { rating_avg: number | null }): string {
  return c.rating_avg != null ? `★${c.rating_avg.toFixed(1)}` : "";
}

export function wrapContractorsResult(args: {
  category: string;
  location_text?: string;
  hits: ContractorCard[];
}): string {
  const locPart = args.location_text
    ? ` near ${args.location_text}`
    : " near them";
  if (args.hits.length === 0) {
    return `[CONTRACTOR SEARCH — not spoken by user] The user asked for ${args.category}${locPart}, but I found no matches. Respond in first person as 6, apologize briefly, and offer to broaden the search (e.g. nearby cities or relaxed filters). One short sentence.`;
  }

  const topList = args.hits
    .slice(0, 5)
    .map(
      (c, i) =>
        `  ${i + 1}. ${c.name} — ${ratingPart(c)} · ${c.distance_km.toFixed(
          1,
        )} km${c.locally_owned ? " · locally owned" : ""}${
          c.same_day_flag ? " · same-day" : ""
        }`,
    )
    .join("\n");

  return [
    `[CONTRACTOR SEARCH — not spoken by user]`,
    `The user asked for a ${args.category}${locPart}. I found ${args.hits.length} candidates ranked by your existing rules. Top 5:`,
    topList,
    `Respond in first person as 6. Lead with the top pick — its name, rating, and how far. Offer to tell them more about it or to look at the rest. Two sentences max. Don't list all 5; the cards are already on screen for the user to see.`,
  ].join("\n");
}

export function wrapSummaryResult(args: {
  contractor_name: string;
  payload: SummaryPayload;
}): string {
  return [
    `[REVIEW SUMMARY — not spoken by user]`,
    `Vision: synthesized reviews for ${args.contractor_name}.`,
    `Overview: ${args.payload.summary}`,
    args.payload.strengths_md.trim() &&
      `Strengths:\n${args.payload.strengths_md.trim()}`,
    args.payload.weaknesses_md.trim() &&
      `Watch-outs:\n${args.payload.weaknesses_md.trim()}`,
    `Respond in first person as 6. Give a 2-sentence read on this contractor — the overall vibe, then one strength and one watch-out. The full panel is already on the user's screen.`,
  ]
    .filter(Boolean)
    .join("\n");
}

export function wrapRecommendationsResult(args: {
  picks: RecommendationCard[];
  preference_facts: string[];
}): string {
  if (args.picks.length === 0) {
    return `[6'S PICKS — not spoken by user] I couldn't find strong matches. Respond in first person as 6 with a one-sentence apology and offer to widen the search.`;
  }
  const top = args.picks[0];
  const prefsLine =
    args.preference_facts.length > 0
      ? `User's tracked preferences: ${args.preference_facts.slice(0, 3).join(", ")}.`
      : "";
  const picksList = args.picks
    .map(
      (p, i) =>
        `  ${i + 1}. ${p.name} — ${ratingPart(p)} · ${p.distance_km.toFixed(
          1,
        )} km — ${p.reason}`,
    )
    .join("\n");
  return [
    `[6'S PICKS — not spoken by user]`,
    prefsLine,
    `Top picks ranked by rating, sentiment, distance, and the user's preferences:`,
    picksList,
    `Respond in first person as 6. Name the #1 pick and the one-line reason why. Offer to tell them more or book it. Two sentences max. The cards are already on screen.`,
  ]
    .filter(Boolean)
    .join("\n");
}

export function wrapPickResult(args: {
  winner_name: string;
  loser_count: number;
  delivered_count: number;
  failed_count: number;
}): string {
  const tail =
    args.failed_count > 0
      ? `(Some notifications failed delivery on vendor side — the trigger fired correctly; this is M1.7 vendor config, not an action failure.)`
      : "";
  return [
    `[BOOKING CONFIRMED — not spoken by user]`,
    `User picked ${args.winner_name}. 6 has just fired the win/lose fan-out: ${args.delivered_count} notifications dispatched, ${args.failed_count} failed.`,
    `${args.loser_count} other candidates were notified with friendly "here's how to win next time" feedback per ¶19.`,
    tail,
    `Respond in first person as 6. Confirm the booking — name the contractor, say they'll be in touch shortly, and acknowledge you also let the other candidates know. Two sentences max. Warm tone.`,
  ]
    .filter(Boolean)
    .join("\n");
}

/**
 * M3.8 — "I can't decide" / "help me choose" entry into deliberation.
 * Brain frames a side-by-side comparison and offers to refine.
 */
export function wrapDeliberateOpen(args: {
  payload: ComparePayload;
}): string {
  const { picks, headlines, active_constraints, preference_facts } =
    args.payload;
  if (picks.length === 0) {
    return `[DELIBERATION — not spoken by user] User asked for help deciding but no candidates matched. Respond as 6 in one sentence — suggest widening the search.`;
  }
  const list = picks
    .map((p, i) => `  ${i + 1}. ${p.name} — ${headlines[i] || p.reason}`)
    .join("\n");
  const constraintsLine =
    active_constraints.length > 0
      ? `Active filters: ${active_constraints.join(", ")}.`
      : "";
  const prefsLine =
    preference_facts.length > 0
      ? `Tracked preferences: ${preference_facts.slice(0, 3).join(", ")}.`
      : "";
  return [
    `[DELIBERATION — not spoken by user]`,
    `User said they can't decide. I've pulled the top ${picks.length} candidates side-by-side with the key differentiators:`,
    list,
    constraintsLine,
    prefsLine,
    `Respond in first person as 6. Lay them out as a 2-way comparison in one sentence — name each pick and its key advantage. Then offer to refine ("want me to narrow it by anything specific?") in one sentence. Two sentences total.`,
  ]
    .filter(Boolean)
    .join("\n");
}

/**
 * M3.8 — User refined constraints ("only locally-owned", "closer than 5km",
 * "not that one"). Brain confirms what changed and re-narrates the new
 * top picks.
 */
export function wrapDeliberateRefine(args: {
  payload: ComparePayload;
  changed: string;
}): string {
  const { picks, headlines } = args.payload;
  if (picks.length === 0) {
    return `[REFINEMENT — not spoken by user] User added a constraint (${args.changed}) but no candidates match anymore. Respond as 6 in one sentence — suggest relaxing or going back.`;
  }
  const top = picks[0];
  const list = picks
    .map((p, i) => `  ${i + 1}. ${p.name} — ${headlines[i] || p.reason}`)
    .join("\n");
  return [
    `[REFINEMENT — not spoken by user]`,
    `User refined the deliberation: ${args.changed}. New top candidates:`,
    list,
    `Respond in first person as 6. Acknowledge the refinement and name the new #1 pick (${top.name}) with the relevant differentiator. Two sentences max.`,
  ].join("\n");
}

/**
 * M3.4 — Confirm a freshly scheduled appointment. Brain reads back the
 * contractor + time + agenda to the homeowner so they're certain.
 */
export function wrapAppointmentScheduled(args: {
  appointment: AppointmentCard;
}): string {
  const { appointment } = args;
  const with_ = appointment.contractor_name
    ? ` with ${appointment.contractor_name}`
    : "";
  const agenda = appointment.agenda.trim()
    ? ` — ${appointment.agenda}`
    : "";
  return [
    `[APPOINTMENT SCHEDULED — not spoken by user]`,
    `Just saved a ${appointment.duration_minutes}-minute appointment${with_} ${appointment.scheduled_when_text}${agenda}. Both parties will get a 24-hour and a 2-hour reminder via 6's notifications fabric.`,
    `Respond as 6 in first person, confirming the time + (if relevant) the other party's name. One sentence.`,
  ].join("\n");
}

/**
 * M3.5 — Confirm a rescheduled appointment. Brain notes the change vs
 * the original.
 */
export function wrapAppointmentRescheduled(args: {
  appointment: AppointmentCard;
}): string {
  const { appointment } = args;
  const with_ = appointment.contractor_name
    ? ` with ${appointment.contractor_name}`
    : "";
  return [
    `[APPOINTMENT RESCHEDULED — not spoken by user]`,
    `Moved the appointment${with_} to ${appointment.scheduled_when_text}. New reminder schedule kicks in.`,
    `Respond as 6 in first person, confirming the new time briefly. One sentence.`,
  ].join("\n");
}

/** M3.4 — Confirm a cancelled appointment. */
export function wrapAppointmentCancelled(args: {
  appointment: AppointmentCard;
}): string {
  const { appointment } = args;
  const with_ = appointment.contractor_name
    ? ` with ${appointment.contractor_name}`
    : "";
  return [
    `[APPOINTMENT CANCELLED — not spoken by user]`,
    `Cancelled the appointment${with_} that was ${appointment.scheduled_when_text}. Reminders disabled.`,
    `Respond as 6 in first person, confirming and offering to reschedule. One short sentence.`,
  ].join("\n");
}

/** M3.4 — Read back a list of upcoming appointments. */
export function wrapAppointmentsList(args: {
  appointments: AppointmentCard[];
}): string {
  if (args.appointments.length === 0) {
    return [
      `[APPOINTMENTS LIST — not spoken by user]`,
      `User asked what's on their calendar. Nothing is scheduled.`,
      `Respond as 6 in first person, one sentence, letting them know they're clear and offering to set something up.`,
    ].join("\n");
  }
  const list = args.appointments
    .slice(0, 5)
    .map(
      (a, i) =>
        `  ${i + 1}. ${a.contractor_name ?? "an appointment"} — ${a.scheduled_when_text}${
          a.agenda.trim() ? ` (${a.agenda})` : ""
        }`,
    )
    .join("\n");
  return [
    `[APPOINTMENTS LIST — not spoken by user]`,
    `User asked what's on their calendar. They have ${args.appointments.length} upcoming:`,
    list,
    `Respond as 6 in first person. Name the very next one (#1) with its time and (if relevant) the contractor. Offer to read more if there are others. Two sentences max.`,
  ].join("\n");
}

/**
 * M3.7 — Confirm a freshly drafted work agreement / e-sign envelope.
 * Brain reads back the contractor + amount + scope and lets the homeowner
 * know what happens next.
 */
export function wrapDraftContract(args: { payload: ContractPayload }): string {
  const { payload } = args;
  const dollars = (payload.amount_cents / 100).toFixed(2);
  const feeDollars = (payload.platform_fee_cents / 100).toFixed(2);
  const c = payload.currency.toUpperCase();
  const sentAlready = payload.envelope.status === "signed";
  return [
    `[CONTRACT DRAFTED — not spoken by user]`,
    `Drafted a work agreement with ${payload.contractor_name}. Scope: ${payload.scope}. Total ${dollars} ${c} (platform fee ${feeDollars} ${c}).`,
    sentAlready
      ? `Mock provider auto-signed the envelope for the test drive; in production both parties would receive signing links by email.`
      : `Envelope is out via ${payload.envelope.provider}; both parties will receive signing emails shortly.`,
    `Respond as 6 in first person. Confirm the contract was drafted, name the contractor and the total, and tell them to check their email to sign. Two sentences max.`,
  ].join("\n");
}

/**
 * M3.9 — Confirm a freshly opened dispute. Brain summarizes the intake
 * and reads back the mediator's opening reply so the homeowner hears
 * what 6 just said in writing.
 */
export function wrapDisputeOpened(args: { payload: DisputePayload }): string {
  const { payload } = args;
  const opener = payload.messages.find((m) => m.sender === "mediator");
  const tail =
    payload.status === "escalated"
      ? `This one's already going to a human — escalation criteria triggered (large amount, user-requested human, or 3-strike rule).`
      : `The mediator's opening reply is: "${opener?.body ?? ""}". The user can respond in the drawer thread.`;
  const withContractor = payload.contractor_name
    ? ` against ${payload.contractor_name}`
    : "";
  return [
    `[DISPUTE OPENED — not spoken by user]`,
    `Just opened a dispute${withContractor}. Complaint: "${payload.complaint}".`,
    tail,
    `Respond as 6 in first person. Acknowledge the dispute calmly, name the contractor (if any), and tell them to look in the drawer to read the mediator's opening response or to keep talking through voice. Two sentences max. Warm, neutral tone.`,
  ].join("\n");
}

/**
 * M3.1 — Confirm a freshly initiated 3-way phone call. Brain reads back
 * who 6 is dialing so the homeowner hears the connection forming.
 */
export function wrapCallPlaced(args: { payload: CallPayload }): string {
  const { payload } = args;
  const who = payload.contractor_name ?? "the contractor";
  return [
    `[CALL DIALING — not spoken by user]`,
    `Just dialed a 3-way call: the homeowner, ${who}, and 6 as a silent participant who joins audibly when the homeowner says "hey 6".`,
    `Status: ${payload.status}. The drawer will show the live transcript as it streams in.`,
    `Respond as 6 in first person. Confirm the call is dialing — name the contractor — and remind the user they can say "hey 6" mid-call if they want me to chime in. Two sentences max.`,
  ].join("\n");
}

/**
 * M3.6 — Confirm a freshly extracted estimate. Brain reads back the
 * top-line scope and total so the homeowner hears the result.
 */
export function wrapEstimateReady(args: { payload: EstimatePayload }): string {
  const { payload } = args;
  const dollars = (payload.total_cents / 100).toFixed(2);
  const c = payload.currency.toUpperCase();
  const itemCount = payload.line_items.length;
  if (itemCount === 0) {
    return [
      `[ESTIMATE EMPTY — not spoken by user]`,
      `Couldn't extract line items from the call — the contractor didn't speak any concrete prices yet.`,
      `Respond as 6 in first person. Acknowledge there's not enough on the call to estimate yet, and offer to ask the contractor for line-item prices. One sentence.`,
    ].join("\n");
  }
  const who = payload.contractor_name ?? "the contractor";
  return [
    `[ESTIMATE READY — not spoken by user]`,
    `Pulled ${itemCount} line item${itemCount === 1 ? "" : "s"} from the call with ${who}. Scope: ${payload.scope_summary}. Total: $${dollars} ${c}.`,
    `Respond as 6 in first person. Name the total, say it's broken down in the drawer, and offer to turn this into a contract. Two sentences max.`,
  ].join("\n");
}

/**
 * M4.7 — Confirm a freshly created recurring job. Brain reads back the
 * schedule + next occurrence so the homeowner hears the autopilot
 * cadence and can correct it if needed.
 */
export function wrapRecurringScheduled(args: {
  payload: RecurringJobPayload;
}): string {
  const { payload } = args;
  const next = payload.next_instances[0]
    ? new Date(payload.next_instances[0]).toLocaleString("en-US", {
        weekday: "long",
        month: "short",
        day: "numeric",
        hour: "numeric",
        minute: "2-digit",
        hour12: true,
        timeZone: payload.timezone,
      })
    : "(no upcoming instance — schedule may have already passed)";
  const who = payload.contractor_name
    ? ` with ${payload.contractor_name}`
    : "";
  return [
    `[RECURRING JOB SCHEDULED — not spoken by user]`,
    `Just set up autopilot for "${payload.title}"${who}. Cadence: ${payload.schedule_human}. Next: ${next}.`,
    `Each instance fires reminders, contractor confirmation, and (if the contractor's a no-show) the backup dispatcher.`,
    `Respond as 6 in first person. Confirm the autopilot is live, name the cadence and the next instance, and tell them they can say "pause the lawn mowing" any time to stop. Two sentences max.`,
  ].join("\n");
}

/**
 * Build a "we couldn't act on this" wrapper for when intent matched but
 * required slots were missing or backend returned nothing.
 */
export function wrapFallback(reason: string): string {
  return [
    `[INTENT NOT ACTIONABLE — not spoken by user]`,
    `User intent matched but no action could be taken. Reason: ${reason}.`,
    `Respond in first person as 6 by either asking the user to clarify or restating what you understood. One short sentence.`,
  ].join("\n");
}

/** Diagnostic helper — used by /api/intent/classify's debug response. */
export function wrapForDebug(intent: string, slotsJson: string): string {
  return `[DEBUG — intent: ${intent}; slots: ${slotsJson}]`;
}

// Convenience re-export of the pick-result type so the orchestrator
// doesn't need a separate import.
export type { PickResultPayload };
