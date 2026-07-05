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
  ContractorOnboardingField,
  ContractorOnboardingPayload,
  DisputePayload,
  EstimatePayload,
  RecommendationCard,
  RecurringJobPayload,
  SummaryPayload,
} from "../assistantSurface/types";
import { buildListIndexReply } from "../lists/listIndex";

function ratingPart(c: { rating_avg: number | null }): string {
  return c.rating_avg != null ? `★${c.rating_avg.toFixed(1)}` : "";
}

export function wrapContractorsResult(args: {
  category: string;
  location_text?: string;
  hits: ContractorCard[];
}): string {
  // "local"/"near" claims only when we actually know the user's area (Herm
  // release blocker #10: unlabeled fallback results must never be presented
  // as local).
  const category = cleanForContext(args.category);
  const locPart = args.location_text
    ? ` near ${cleanForContext(args.location_text)}`
    : "";
  if (args.hits.length === 0) {
    return `[CONTRACTOR SEARCH — not spoken by user] The user asked for ${category}${locPart || " (area unknown)"}, but I found no matches. Respond in first person as 6, apologize briefly, and offer to broaden the search (e.g. nearby cities or relaxed filters). One short sentence.`;
  }

  // Distance is only shown when we actually know it (> 0). Never speak a fake
  // "0.0 km" — G's reality doctrine (Herm audit 2026-06-30).
  const topList = args.hits
    .slice(0, 5)
    .map((c, i) => {
      const bits = [
        ratingPart(c),
        c.area_label ? cleanForContext(c.area_label) : "",
        c.distance_km > 0 ? `${c.distance_km.toFixed(1)} km` : "",
        c.distance_note === "same_area_unknown"
          ? "same area, distance unknown"
          : "",
        c.locally_owned ? "locally owned" : "",
        c.same_day_flag ? "same-day" : "",
      ].filter(Boolean);
      return `  ${i + 1}. ${cleanForContext(c.name)}${bits.length ? " — " + bits.join(" · ") : ""}`;
    })
    .join("\n");

  // Nearby-fill cards (3-minimum) are honest but NOT exact-local — the brain
  // must never claim locality/distance for them (Herm TASK_086).
  const hasSameAreaFill = args.hits.some(
    (h) => h.distance_note === "same_area_unknown",
  );
  return [
    `[CONTRACTOR SEARCH — not spoken by user]`,
    args.location_text
      ? `The user asked for a ${category}${locPart}. I found ${args.hits.length} real pros from real directory supply for that area. Top 5:`
      : `The user asked for a ${category}. I found ${args.hits.length} real pros — but their area is NOT confirmed, so do NOT call these "local" or "near you". Top 5:`,
    topList,
    hasSameAreaFill
      ? `Some of these cards are nearby pros from the same broader area (labeled "same area, distance unknown" on their card) because the exact area had fewer than 3. Do NOT call those ones exact-local and do NOT give a distance for them.`
      : "",
    `Respond in first person as 6. Lead with the top pick — its name and rating (and how far only if a distance is shown above; never invent one). Only call them local/nearby if the line above names the area. Offer to tell them more about it or to look at the rest. Two sentences max. Don't list all 5; the cards are already on screen for the user to see.`,
  ]
    .filter(Boolean)
    .join("\n");
}

export function wrapSummaryResult(args: {
  contractor_name: string;
  payload: SummaryPayload;
}): string {
  // Summary + strengths/weaknesses are LLM output synthesized from scraped
  // review text — external-origin data, so it goes through the bounded block
  // cleaner before touching the brain (Herm TASK_072 blocker #9).
  const strengths = cleanBlockForContext(args.payload.strengths_md);
  const weaknesses = cleanBlockForContext(args.payload.weaknesses_md);
  return [
    `[REVIEW SUMMARY — not spoken by user]`,
    `Vision: synthesized reviews for ${cleanForContext(args.contractor_name)}.`,
    `Overview: ${cleanBlockForContext(args.payload.summary, 500)}`,
    strengths && `Strengths:\n${strengths}`,
    weaknesses && `Watch-outs:\n${weaknesses}`,
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
      ? `User's tracked preferences: ${args.preference_facts.slice(0, 3).map((f) => cleanForContext(f)).join(", ")}.`
      : "";
  const picksList = args.picks
    .map((p, i) => {
      const bits = [
        ratingPart(p),
        p.distance_km > 0 ? `${p.distance_km.toFixed(1)} km` : "",
      ].filter(Boolean);
      const meta = bits.length ? `${bits.join(" · ")} — ` : "";
      return `  ${i + 1}. ${cleanForContext(p.name)} — ${meta}${cleanForContext(p.reason)}`;
    })
    .join("\n");
  return [
    `[6'S PICKS — not spoken by user]`,
    prefsLine,
    `Top picks ranked by rating, sentiment, distance, and the user's preferences:`,
    picksList,
    `Respond in first person as 6. Name the #1 pick and the one-line reason why. Offer to tell them more or to get them on the phone — never say you can book them (automatic booking is not live). Two sentences max. The cards are already on screen.`,
  ]
    .filter(Boolean)
    .join("\n");
}

// wrapPickResult was REMOVED 2026-07-02 (Herm TASK_072 #12): it was dead code
// carrying "BOOKING CONFIRMED / notifications dispatched / they'll be in touch
// shortly" copy — false claims while automatic booking (/api/intent/book) is
// 501. The active flow speaks the truth via handleBook() in the orchestrator.
// Don't resurrect it until real booking/notification fan-out exists.

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
    .map((p, i) => `  ${i + 1}. ${cleanForContext(p.name)} — ${cleanForContext(headlines[i] || p.reason)}`)
    .join("\n");
  const constraintsLine =
    active_constraints.length > 0
      ? `Active filters: ${active_constraints.map((c) => cleanForContext(c)).join(", ")}.`
      : "";
  const prefsLine =
    preference_facts.length > 0
      ? `Tracked preferences: ${preference_facts.slice(0, 3).map((f) => cleanForContext(f)).join(", ")}.`
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
  const changed = cleanForContext(args.changed);
  if (picks.length === 0) {
    return `[REFINEMENT — not spoken by user] User added a constraint (${changed}) but no candidates match anymore. Respond as 6 in one sentence — suggest relaxing or going back.`;
  }
  const top = picks[0];
  const list = picks
    .map((p, i) => `  ${i + 1}. ${cleanForContext(p.name)} — ${cleanForContext(headlines[i] || p.reason)}`)
    .join("\n");
  return [
    `[REFINEMENT — not spoken by user]`,
    `User refined the deliberation: ${changed}. New top candidates:`,
    list,
    `Respond in first person as 6. Acknowledge the refinement and name the new #1 pick (${cleanForContext(top.name)}) with the relevant differentiator. Two sentences max.`,
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
    ? ` with ${cleanForContext(appointment.contractor_name)}`
    : "";
  const agenda = appointment.agenda.trim()
    ? ` — ${cleanForContext(appointment.agenda)}`
    : "";
  return [
    `[APPOINTMENT SCHEDULED — not spoken by user]`,
    `Just saved a ${appointment.duration_minutes}-minute appointment${with_} ${cleanForContext(appointment.scheduled_when_text)}${agenda}. Both parties will get a 24-hour and a 2-hour reminder via 6's notifications fabric.`,
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
    ? ` with ${cleanForContext(appointment.contractor_name)}`
    : "";
  return [
    `[APPOINTMENT RESCHEDULED — not spoken by user]`,
    `Moved the appointment${with_} to ${cleanForContext(appointment.scheduled_when_text)}. New reminder schedule kicks in.`,
    `Respond as 6 in first person, confirming the new time briefly. One sentence.`,
  ].join("\n");
}

/** M3.4 — Confirm a cancelled appointment. */
export function wrapAppointmentCancelled(args: {
  appointment: AppointmentCard;
}): string {
  const { appointment } = args;
  const with_ = appointment.contractor_name
    ? ` with ${cleanForContext(appointment.contractor_name)}`
    : "";
  return [
    `[APPOINTMENT CANCELLED — not spoken by user]`,
    `Cancelled the appointment${with_} that was ${cleanForContext(appointment.scheduled_when_text)}. Reminders disabled.`,
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
        `  ${i + 1}. ${a.contractor_name ? cleanForContext(a.contractor_name) : "an appointment"} — ${cleanForContext(a.scheduled_when_text)}${
          a.agenda.trim() ? ` (${cleanForContext(a.agenda)})` : ""
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

// ─── Lists (G 2026-07-01: 6-led, voice-first; ported from aiASAP) ────

/** Titles are DATA, never instructions (Herm TASK_068 blocker #2): they come
 * from STT captures and DB rows, and get interpolated into brain context.
 * Strip control chars/newlines + the [TAG] brackets our wrappers use as
 * markers, collapse whitespace, cap length. */
// Full C0 control range + DEL (Herm TASK_070 blocker #1) - built from char
// codes ON PURPOSE: literal control characters (and even their escape
// sequences) in this file have bitten us repeatedly tonight, including a raw
// DEL byte that hid inside the old character class.
const CONTROL_CHARS_RE = new RegExp(
  "[" +
    String.fromCharCode(0) +
    "-" +
    String.fromCharCode(31) +
    String.fromCharCode(127) +
    "]",
  "g",
);
export function cleanForContext(raw: string, cap = 120): string {
  return String(raw ?? "")
    .replace(CONTROL_CHARS_RE, " ")
    .replace(/[[\]{}<>`]/g, "")
    .replace(/"/g, "'")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, cap);
}

// Same policy as CONTROL_CHARS_RE but LF (10) survives — for multi-line
// blocks. Built from char codes for the same corruption-history reason.
const CONTROL_CHARS_EXCEPT_NL_RE = new RegExp(
  "[" +
    String.fromCharCode(0) +
    "-" +
    String.fromCharCode(9) +
    String.fromCharCode(11) +
    "-" +
    String.fromCharCode(31) +
    String.fromCharCode(127) +
    "]",
  "g",
);

/** Bounded cleaner for multi-line blocks (LLM summaries, review-derived
 * markdown): strips everything cleanForContext strips except newlines, and
 * caps the block so one oversized summary can't flood the brain's context
 * (Herm TASK_072 blocker #9: external-origin text reached session.message
 * raw). */
function cleanBlockForContext(raw: string, cap = 900): string {
  return String(raw ?? "")
    .replace(CONTROL_CHARS_EXCEPT_NL_RE, " ")
    .replace(/[[\]{}<>`]/g, "")
    .replace(/"/g, "'")
    .replace(/[^\S\n]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim()
    .slice(0, cap);
}

function speakItems(rawTitles: string[]): string {
  const titles = rawTitles.map(cleanForContext);
  if (titles.length === 1) return `"${titles[0]}"`;
  if (titles.length === 2) return `"${titles[0]}" and "${titles[1]}"`;
  return (
    titles
      .slice(0, -1)
      .map((t) => `"${t}"`)
      .join(", ") + `, and "${titles[titles.length - 1]}"`
  );
}

/** Confirm freshly added item(s) — or the truth when they were all dupes. */
export function wrapTodoAdded(args: {
  titles: string[];
  alreadyThere: string[];
  listTitle: string;
  openCount: number;
}): string {
  const listTitle = cleanForContext(args.listTitle);
  if (args.titles.length === 0) {
    return [
      `[LIST ADD — not spoken by user]`,
      `${speakItems(args.alreadyThere)} ${args.alreadyThere.length === 1 ? "is" : "are"} ALREADY on the ${listTitle} list — nothing new was added.`,
      `Respond as 6 in first person: it's already on there. One short sentence. Never claim you added it.`,
    ].join("\n");
  }
  return [
    `[LIST ADD — not spoken by user]`,
    `Just saved ${speakItems(args.titles)} to the user's ${listTitle} list. The list now has ${args.openCount} open item${args.openCount === 1 ? "" : "s"}.`,
    `Respond as 6 in first person, confirming ${args.titles.length === 1 ? "it's" : "they're"} on the list. One short sentence.`,
  ].join("\n");
}

/**
 * Read a list back. The numbering here is what 6 speaks — positional
 * commands ("take off number two") resolve against this same order.
 */
export function wrapTodosList(args: {
  listTitle: string;
  titles: string[];
}): string {
  const listTitle = cleanForContext(args.listTitle);
  if (args.titles.length === 0) {
    return [
      `[LIST — not spoken by user]`,
      `User asked what's on their ${listTitle} list. It's empty.`,
      `Respond as 6 in first person, one sentence: the list is clear, and offer to add something.`,
    ].join("\n");
  }
  const list = args.titles
    .slice(0, 10)
    .map((t, i) => `  ${i + 1}. ${cleanForContext(t)}`)
    .join("\n");
  const extra =
    args.titles.length > 10 ? ` (plus ${args.titles.length - 10} more)` : "";
  return [
    `[LIST — not spoken by user]`,
    `User asked what's on their ${listTitle} list. ${args.titles.length} open item${args.titles.length === 1 ? "" : "s"}${extra}:`,
    list,
    `Respond as 6 in first person. Read the items back in this order, numbered. Keep it tight.`,
  ].join("\n");
}

/** Confirm a checked-off (done) item. */
export function wrapTodoCompleted(args: {
  title: string;
  listTitle: string;
  openCount: number;
}): string {
  return [
    `[LIST ITEM CHECKED OFF — not spoken by user]`,
    `Just marked "${cleanForContext(args.title)}" done on the ${cleanForContext(args.listTitle)} list. ${args.openCount} open item${args.openCount === 1 ? "" : "s"} left.`,
    `Respond as 6 in first person, confirming it's checked off and (if any remain) how many are left. One sentence.`,
  ].join("\n");
}

/** Confirm removed (dropped) item(s). */
export function wrapTodoRemoved(args: {
  titles: string[];
  listTitle: string;
  openCount: number;
}): string {
  return [
    `[LIST ITEMS REMOVED — not spoken by user]`,
    `Just took ${speakItems(args.titles)} off the ${cleanForContext(args.listTitle)} list. ${args.openCount} open item${args.openCount === 1 ? "" : "s"} left.`,
    `Respond as 6 in first person, confirming what came off. One short sentence.`,
  ].join("\n");
}

/** Confirm a whole-list clear — only ever say it when rows really changed
 * (aiASAP lesson: 6 said "done" while nothing cleared). */
export function wrapListCleared(args: {
  listTitle: string;
  count: number;
}): string {
  return [
    `[LIST CLEARED — not spoken by user]`,
    `Just cleared the ${cleanForContext(args.listTitle)} list — ${args.count} item${args.count === 1 ? "" : "s"} removed. It's empty now.`,
    `Respond as 6 in first person: the list is cleared, fresh start. One short sentence.`,
  ].join("\n");
}

/** The list-of-lists menu ("what are my lists"). Titles are sanitized BEFORE
 * they reach buildListIndexReply so the spoken menu carries no raw data. */
export function wrapListIndex(args: { titles: string[] }): string {
  return [
    `[LISTS MENU — not spoken by user]`,
    `User asked which lists they have. The exact spoken reply to give: "${buildListIndexReply(args.titles.map(cleanForContext))}"`,
    `Respond as 6 in first person using that reply, natural delivery.`,
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
    `Drafted a work agreement with ${cleanForContext(payload.contractor_name)}. Scope: ${cleanForContext(payload.scope)}. Total ${dollars} ${c} (platform fee ${feeDollars} ${c}).`,
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
      : `The mediator's opening reply is: "${cleanForContext(opener?.body ?? "", 500)}". The user can respond in the drawer thread.`;
  const withContractor = payload.contractor_name
    ? ` against ${cleanForContext(payload.contractor_name)}`
    : "";
  return [
    `[DISPUTE OPENED — not spoken by user]`,
    `Just opened a dispute${withContractor}. Complaint: "${cleanForContext(payload.complaint)}".`,
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
  const who = payload.contractor_name
    ? cleanForContext(payload.contractor_name)
    : "the contractor";
  return [
    `[CALL DIALING — not spoken by user]`,
    `Just dialed a 3-way call: the homeowner, ${who}, and 6 as a silent participant who joins audibly when the homeowner says "hey 6".`,
    `Status: ${cleanForContext(payload.status)}. The drawer will show the live transcript as it streams in.`,
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
  const who = payload.contractor_name
    ? cleanForContext(payload.contractor_name)
    : "the contractor";
  return [
    `[ESTIMATE READY — not spoken by user]`,
    `Pulled ${itemCount} line item${itemCount === 1 ? "" : "s"} from the call with ${who}. Scope: ${cleanForContext(payload.scope_summary, 300)}. Total: $${dollars} ${c}.`,
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
    ? ` with ${cleanForContext(payload.contractor_name)}`
    : "";
  return [
    `[RECURRING JOB SCHEDULED — not spoken by user]`,
    `Just set up autopilot for "${cleanForContext(payload.title)}"${who}. Cadence: ${cleanForContext(payload.schedule_human)}. Next: ${next}.`,
    `Each instance fires reminders, contractor confirmation, and (if the contractor's a no-show) the backup dispatcher.`,
    `Respond as 6 in first person. Confirm the autopilot is live, name the cadence and the next instance, and tell them they can say "pause the lawn mowing" any time to stop. Two sentences max.`,
  ].join("\n");
}

/**
 * M4.9 — Confirm a go-between session is starting. Brain reads back
 * that 6 is dialing both parties and coaches the homeowner on how to
 * use it — put the phone on speaker so the contractor standing there
 * can hear 6 mediate too.
 */
export function wrapGoBetweenStarted(args: {
  payload: CallPayload;
}): string {
  const { payload } = args;
  const with_ = payload.contractor_name
    ? ` with ${cleanForContext(payload.contractor_name)}`
    : "";
  return [
    `[GO-BETWEEN MODE STARTED — not spoken by user]`,
    `Just started a mediation call${with_}. 6 will hear both sides through the phone and can speak into the conference when addressed by name. The homeowner and contractor are in the same room — the homeowner should put their phone on speaker so both sides can hear 6.`,
    `Respond as 6 in first person, one or two sentences. Tell them the call is dialing, ask them to put you on speaker, and mention you'll chime in when addressed by name.`,
  ].join("\n");
}

/**
 * M4.4 — Confirm a homeowner-reported no-show dispatch. Brain narrates
 * that the original contractor was flagged and a fan-out to same-day
 * substitutes is out (or not — dispatch may skip if nobody's nearby).
 */
export function wrapNoShowDispatched(args: {
  appointment: AppointmentCard;
  invited_count: number;
  skipped_reason?: string;
}): string {
  const { appointment, invited_count, skipped_reason } = args;
  const originalWith = appointment.contractor_name
    ? ` (${cleanForContext(appointment.contractor_name)})`
    : "";
  const whenText = cleanForContext(appointment.scheduled_when_text);
  if (skipped_reason === "no_invitables") {
    return [
      `[NO-SHOW REPORTED — not spoken by user]`,
      `Flagged the appointment${originalWith} scheduled ${whenText} as a no-show, but no same-day substitutes were reachable in the area.`,
      `Respond as 6 in first person, one short sentence. Acknowledge the no-show, say you flagged it, and offer to broaden the search or reschedule instead.`,
    ].join("\n");
  }
  if (invited_count === 0) {
    return [
      `[NO-SHOW REPORTED — not spoken by user]`,
      `Flagged the appointment${originalWith} scheduled ${whenText} as a no-show. Dispatch was attempted but no invitations went out (see server logs).`,
      `Respond as 6 in first person, one sentence. Acknowledge the report and offer to try again or reschedule.`,
    ].join("\n");
  }
  return [
    `[NO-SHOW REPORTED — not spoken by user]`,
    `Flagged the appointment${originalWith} scheduled ${whenText} as a no-show and invited ${invited_count} same-day substitute contractor${invited_count === 1 ? "" : "s"}. First to accept wins.`,
    `Respond as 6 in first person, one or two sentences. Acknowledge the no-show, tell them you've dispatched ${invited_count} nearby ${invited_count === 1 ? "contractor" : "contractors"} and you'll ping them the moment someone accepts.`,
  ].join("\n");
}

// ─── Contractor onboarding (TASK_061) ───────────────────────────────

const CONTRACTOR_ONBOARDING_FIELD_LABELS: Record<
  ContractorOnboardingField,
  string
> = {
  business_name: "business name",
  trade: "trade or specialty",
  service_area: "service area (city/state)",
  phone_or_email: "best phone number or email",
  licensed: "whether they are licensed",
  same_day: "whether they take same-day jobs",
  locally_owned: "whether they are locally owned",
};

/**
 * 6 is interviewing a trade pro by voice. Tell the brain what's captured and
 * exactly which ONE field to ask for next — one short question, no form, and
 * never claim the profile is saved yet.
 */
export function wrapContractorOnboardingPrompt(args: {
  payload: ContractorOnboardingPayload;
}): string {
  const { draft, missing_fields } = args.payload;
  // Every draft field is user speech captured by STT — external-origin data
  // (Herm TASK_072 blocker #9).
  const captured = [
    draft.business_name && `Business: ${cleanForContext(draft.business_name)}`,
    draft.categories?.length &&
      `Trade: ${draft.categories.map((t) => cleanForContext(t)).join(", ")}`,
    (draft.city || draft.state) &&
      `Service area: ${[draft.city, draft.state]
        .filter(Boolean)
        .map((v) => cleanForContext(String(v)))
        .join(", ")}`,
    draft.phone && `Phone: ${cleanForContext(draft.phone)}`,
    draft.email && `Email: ${cleanForContext(draft.email)}`,
    draft.licensed_flag != null && `Licensed: ${draft.licensed_flag ? "yes" : "no"}`,
    draft.same_day_flag != null && `Same-day: ${draft.same_day_flag ? "yes" : "no"}`,
    draft.locally_owned != null &&
      `Locally owned: ${draft.locally_owned ? "yes" : "no"}`,
  ]
    .filter(Boolean)
    .join("; ");
  const next = missing_fields[0];
  if (!next) {
    return [
      `[CONTRACTOR ONBOARDING — not spoken by user]`,
      `Captured contractor profile fields: ${captured || "none"}.`,
      `All required fields appear present. Respond as 6 in first person. Read back the profile briefly and ask: "Want me to save this profile?" Do NOT say it is saved yet.`,
    ].join("\n");
  }
  return [
    `[CONTRACTOR ONBOARDING — not spoken by user]`,
    `The user is a contractor/trade pro signing up for leads. Captured so far: ${captured || "none yet"}.`,
    `Next missing field: ${CONTRACTOR_ONBOARDING_FIELD_LABELS[next]}.`,
    `Respond as 6 in first person. Ask exactly ONE short question for that missing field. No form. Do NOT say the profile is saved yet.`,
  ].join("\n");
}

/** The save succeeded and a real row exists — 6 can confirm they're in. */
export function wrapContractorProfileSaved(args: {
  payload: ContractorOnboardingPayload;
}): string {
  const d = args.payload.draft;
  const name = d.business_name ? cleanForContext(d.business_name) : "your business";
  const trade = d.categories?.[0] ? cleanForContext(d.categories[0]) : "work";
  const area =
    [d.city, d.state]
      .filter(Boolean)
      .map((v) => cleanForContext(String(v)))
      .join(", ") || "your area";
  // Only promise nearby discoverability when we actually have coords to match
  // on. City-only rows can't geo-match yet, so we say so honestly (Herm #2).
  const hasCoords = d.lat != null && d.lng != null;
  const visibility = hasCoords
    ? `Say: "You're in, ${name} — you'll show up when homeowners near ${area} need ${trade}."`
    : `Say: "You're in, ${name} — I've saved your profile and service area (${area}). You'll start showing up for homeowners there as I pin down your spot."`;
  return [
    `[CONTRACTOR PROFILE SAVED — not spoken by user]`,
    `Saved contractor profile for ${name} (id ${cleanForContext(args.payload.contractor_id ?? "unknown")}).`,
    `Respond as 6 in first person. ${visibility} Then add one short next step: "I'll help you tighten the profile as we learn what wins jobs."`,
  ].join("\n");
}

/**
 * Build a "we couldn't act on this" wrapper for when intent matched but
 * required slots were missing or backend returned nothing.
 */
export function wrapFallback(reason: string): string {
  // Reasons can carry user speech (e.g. an unresolved contractor name) —
  // cleaned like every other external-origin field.
  return [
    `[INTENT NOT ACTIONABLE — not spoken by user]`,
    `User intent matched but no action could be taken. Reason: ${cleanForContext(reason, 200)}.`,
    `Respond in first person as 6 by either asking the user to clarify or restating what you understood. One short sentence.`,
  ].join("\n");
}

/** Diagnostic helper — used by /api/intent/classify's debug response. Slots
 * carry raw user text, so this is cleaned too (the brackets in the JSON get
 * stripped — it's a debug breadcrumb, not a parseable payload). */
export function wrapForDebug(intent: string, slotsJson: string): string {
  return `[DEBUG — intent: ${cleanForContext(intent)}; slots: ${cleanForContext(slotsJson, 400)}]`;
}
