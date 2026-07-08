import { randomUUID } from "node:crypto";
import { OPENAI_API_KEY } from "../../../app/api/secrets";
import { getSupabaseAdminConfig } from "../supabaseAdmin";
import { getActiveTierForContractor } from "../billing/store";
import { tierUnlocks } from "../billing/tiers";

/**
 * M4.3 — Tool & material checklist generator.
 *
 * Vision ¶24: "rarely forget a tool or the right materials."
 *
 * Given an appointment + its contract scope + the contractor's
 * category, ask the LLM for a structured pre-departure checklist
 * with three buckets: tools, materials, confirmations (the small
 * "did you bring the dog treats / call ahead" reminders).
 *
 * v1 generates fresh each appointment (Q4.3a (a)). Output JSON is
 * shape-validated before persistence; bad LLM rows are dropped.
 *
 * Tier gate: bronze+. If the contractor is free-tier, generation is
 * a silent no-op (returns reason='tier_gate'). The dashboard renders
 * an upsell tile instead.
 */

const CHECKLIST_MODEL = process.env.CHECKLIST_MODEL || "gpt-4o-mini";
const MAX_ITEMS = 20;

export type ChecklistItemKind = "tool" | "material" | "confirmation";

export type ChecklistItem = {
  id: string;
  kind: ChecklistItemKind;
  text: string;
  checked_at?: string | null;
  checked_by_user_id?: string | null;
};

export type AppointmentChecklistRow = {
  id: string;
  appointment_id: string;
  contractor_id: string;
  items: ChecklistItem[];
  model: string | null;
  generated_at: string;
  context: Record<string, unknown>;
  created_at: string;
  updated_at: string;
};

export type GenerateChecklistInput = {
  appointment_id: string;
  contractor_id: string;
  agenda: string;
  scope: string | null;
  category: string | null;
};

export type GenerateChecklistResult =
  | { ok: true; row: AppointmentChecklistRow; generated: boolean }
  | {
      ok: false;
      reason:
        | "tier_gate"
        | "openai_not_configured"
        | "llm_http_error"
        | "llm_parse_failed"
        | "llm_fetch_threw"
        | "persist_failed";
      debug?: string;
    };

const SYSTEM_PROMPT = [
  `You are 6, an AI assistant for a field contractor about to head out to a job. Produce a pre-departure checklist so they don't forget anything.`,
  ``,
  `Output STRICT JSON ONLY in the shape:`,
  `{`,
  `  "items": [`,
  `    { "kind": "tool"|"material"|"confirmation", "text": "<short imperative>" }`,
  `  ]`,
  `}`,
  ``,
  `Rules:`,
  ` - "tool" = a physical tool they need to bring (drill, ladder, pipe wrench).`,
  ` - "material" = consumables / parts (PVC fittings, drywall mud, gallon of paint).`,
  ` - "confirmation" = a non-physical step (call homeowner to confirm parking, verify gate code, bring insurance certificate).`,
  ` - Each "text" is a short imperative under 80 characters.`,
  ` - Prioritise the items most relevant to the specific scope. Don't pad with generic items.`,
  ` - 5–12 items total is typical. Hard maximum 20.`,
  ` - If you cannot tell what kind of job this is, return a short list of universally-useful items (gloves, safety glasses, business card, payment method).`,
  ` - Never include items already obviously implied (e.g. "wear pants").`,
].join("\n");

function adminHeaders(serviceRoleKey: string) {
  return {
    apikey: serviceRoleKey,
    Authorization: `Bearer ${serviceRoleKey}`,
    "Content-Type": "application/json",
  };
}

function sanitizeItem(raw: unknown): Omit<ChecklistItem, "id"> | null {
  if (typeof raw !== "object" || raw === null) return null;
  const r = raw as { kind?: unknown; text?: unknown };
  const kind =
    r.kind === "tool" || r.kind === "material" || r.kind === "confirmation"
      ? r.kind
      : null;
  if (!kind) return null;
  if (typeof r.text !== "string") return null;
  const text = r.text.trim().slice(0, 120);
  if (text.length < 2) return null;
  return { kind, text };
}

async function callLlm(args: GenerateChecklistInput): Promise<
  | { ok: true; items: ChecklistItem[] }
  | { ok: false; reason: "llm_http_error" | "llm_parse_failed" | "llm_fetch_threw"; debug?: string }
> {
  const userContent = [
    args.category ? `Job category: ${args.category}` : null,
    `Agenda: ${args.agenda || "(none given)"}`,
    args.scope ? `Contract scope: ${args.scope}` : null,
  ]
    .filter(Boolean)
    .join("\n");

  let raw: string;
  try {
    const res = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${OPENAI_API_KEY}`,
      },
      body: JSON.stringify({
        model: CHECKLIST_MODEL,
        response_format: { type: "json_object" },
        temperature: 0.2,
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content: `${userContent}\n\nReturn the checklist JSON.` },
        ],
      }),
    });
    if (!res.ok) {
      return {
        ok: false,
        reason: "llm_http_error",
        debug: `openai ${res.status}: ${(await res.text()).slice(0, 300)}`,
      };
    }
    const data = await res.json();
    raw = data?.choices?.[0]?.message?.content ?? "";
  } catch (e) {
    return {
      ok: false,
      reason: "llm_fetch_threw",
      debug: e instanceof Error ? e.message : "unknown",
    };
  }

  let parsed: { items?: unknown };
  try {
    parsed = JSON.parse(raw);
  } catch {
    return {
      ok: false,
      reason: "llm_parse_failed",
      debug: `couldn't JSON.parse: ${raw.slice(0, 200)}`,
    };
  }

  const cleaned: ChecklistItem[] = [];
  if (Array.isArray(parsed.items)) {
    for (const raw of parsed.items) {
      const s = sanitizeItem(raw);
      if (s) {
        cleaned.push({ ...s, id: randomUUID(), checked_at: null, checked_by_user_id: null });
        if (cleaned.length >= MAX_ITEMS) break;
      }
    }
  }
  return { ok: true, items: cleaned };
}

async function upsertChecklist(args: {
  appointment_id: string;
  contractor_id: string;
  items: ChecklistItem[];
  model: string;
  context: Record<string, unknown>;
}): Promise<AppointmentChecklistRow | null> {
  const { url, serviceRoleKey } = getSupabaseAdminConfig();
  const row = {
    appointment_id: args.appointment_id,
    contractor_id: args.contractor_id,
    items: args.items,
    model: args.model,
    context: args.context,
    generated_at: new Date().toISOString(),
  };
  const res = await fetch(
    `${url}/rest/v1/appointment_checklists?on_conflict=appointment_id`,
    {
      method: "POST",
      headers: {
        ...adminHeaders(serviceRoleKey),
        Prefer: "return=representation,resolution=merge-duplicates",
      },
      body: JSON.stringify([row]),
    },
  );
  if (!res.ok) {
    console.error("checklist upsert failed:", res.status, await res.text());
    return null;
  }
  const rows = (await res.json()) as AppointmentChecklistRow[];
  return rows[0] ?? null;
}

export async function getChecklistByAppointmentId(
  appointment_id: string,
): Promise<AppointmentChecklistRow | null> {
  const { url, serviceRoleKey } = getSupabaseAdminConfig();
  const res = await fetch(
    `${url}/rest/v1/appointment_checklists?appointment_id=eq.${encodeURIComponent(
      appointment_id,
    )}&select=*&limit=1`,
    { headers: adminHeaders(serviceRoleKey), cache: "no-store" },
  );
  if (!res.ok) return null;
  const rows = (await res.json()) as AppointmentChecklistRow[];
  return rows[0] ?? null;
}

export async function listChecklistsForContractor(args: {
  contractor_id: string;
  appointment_ids: string[];
}): Promise<AppointmentChecklistRow[]> {
  if (args.appointment_ids.length === 0) return [];
  const { url, serviceRoleKey } = getSupabaseAdminConfig();
  const qs = new URLSearchParams();
  qs.set("contractor_id", `eq.${args.contractor_id}`);
  qs.set("appointment_id", `in.(${args.appointment_ids.join(",")})`);
  qs.set("select", "*");
  const res = await fetch(
    `${url}/rest/v1/appointment_checklists?${qs.toString()}`,
    { headers: adminHeaders(serviceRoleKey), cache: "no-store" },
  );
  if (!res.ok) return [];
  return (await res.json()) as AppointmentChecklistRow[];
}

/**
 * Toggle a single checklist item. Returns the updated row or null on
 * failure. The caller must have already authorized the actor against
 * the appointment's contractor.
 */
export async function setChecklistItemChecked(args: {
  appointment_id: string;
  item_id: string;
  checked: boolean;
  user_id: string;
}): Promise<AppointmentChecklistRow | null> {
  const existing = await getChecklistByAppointmentId(args.appointment_id);
  if (!existing) return null;
  const updated = existing.items.map((it) =>
    it.id === args.item_id
      ? {
          ...it,
          checked_at: args.checked ? new Date().toISOString() : null,
          checked_by_user_id: args.checked ? args.user_id : null,
        }
      : it,
  );
  const { url, serviceRoleKey } = getSupabaseAdminConfig();
  const res = await fetch(
    `${url}/rest/v1/appointment_checklists?id=eq.${encodeURIComponent(existing.id)}`,
    {
      method: "PATCH",
      headers: {
        ...adminHeaders(serviceRoleKey),
        Prefer: "return=representation",
      },
      body: JSON.stringify({ items: updated }),
    },
  );
  if (!res.ok) return null;
  const rows = (await res.json()) as AppointmentChecklistRow[];
  return rows[0] ?? null;
}

/**
 * Generate (or regenerate) a checklist for an appointment. Idempotent
 * when called with `force=false` and a row already exists.
 *
 * Tier gate: bronze+. Free-tier returns `tier_gate` cleanly so the
 * cron can skip without surfacing an error.
 */
export async function generateChecklist(args: GenerateChecklistInput & {
  force?: boolean;
  reason?: string;
}): Promise<GenerateChecklistResult> {
  // Tier gate.
  const tier = await getActiveTierForContractor(args.contractor_id);
  if (!tierUnlocks(tier, "checklist_agent")) {
    return { ok: false, reason: "tier_gate" };
  }

  if (!args.force) {
    const existing = await getChecklistByAppointmentId(args.appointment_id);
    if (existing) return { ok: true, row: existing, generated: false };
  }

  if (!OPENAI_API_KEY) {
    return { ok: false, reason: "openai_not_configured" };
  }

  const llm = await callLlm(args);
  if (!llm.ok) return llm;

  const row = await upsertChecklist({
    appointment_id: args.appointment_id,
    contractor_id: args.contractor_id,
    items: llm.items,
    model: CHECKLIST_MODEL,
    context: {
      tier,
      regenerated: !!args.force,
      reason: args.reason ?? "auto",
    },
  });
  if (!row) return { ok: false, reason: "persist_failed" };
  return { ok: true, row, generated: true };
}

/**
 * Mark the appointment as "checklist notified" so the cron doesn't
 * fan out a second checklist email. Mirrors markReminderSent.
 */
export async function markChecklistNotified(args: {
  appointment_id: string;
}): Promise<boolean> {
  const { url, serviceRoleKey } = getSupabaseAdminConfig();
  try {
    const res = await fetch(
      `${url}/rest/v1/appointments?id=eq.${encodeURIComponent(args.appointment_id)}`,
      {
        method: "PATCH",
        headers: {
          ...adminHeaders(serviceRoleKey),
          Prefer: "return=minimal",
        },
        body: JSON.stringify({ checklist_notified_at: new Date().toISOString() }),
      },
    );
    if (!res.ok) {
      console.error("markChecklistNotified failed:", res.status, await res.text());
      return false;
    }
    return true;
  } catch (error) {
    console.error("markChecklistNotified threw:", error);
    return false;
  }
}
