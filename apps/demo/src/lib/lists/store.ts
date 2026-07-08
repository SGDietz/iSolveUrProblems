import { getSupabaseAdminConfig } from "../supabaseAdmin";
import {
  MAX_ITEMS_PER_LIST,
  MAX_ITEM_CHARS,
  MAX_LISTS,
  type ListItemRow,
  type ListKind,
  type ListRow,
} from "./types";

/**
 * 6-led list persistence (G 2026-07-01: lists for homeowners AND contractors,
 * ported from aiASAP's list system onto Supabase tables).
 *
 * Service-role writes so the voice orchestrator can insert; owner-scoped
 * reads via RLS for direct client queries. Every helper fails SOFT (null /
 * empty / -1) — INCLUDING thrown errors (missing env, network drop), not just
 * non-OK responses (Herm TASK_068 blocker #1). A store problem must never
 * take down the talk flow; the orchestrator turns the soft value into a
 * spoken fallback.
 */

const DEFAULT_LIST_TITLE = "To-Do";

function adminHeaders(serviceRoleKey: string) {
  return {
    apikey: serviceRoleKey,
    Authorization: `Bearer ${serviceRoleKey}`,
    "Content-Type": "application/json",
  };
}

export async function listLists(args: {
  user_id: string;
}): Promise<ListRow[]> {
  try {
    const { url, serviceRoleKey } = getSupabaseAdminConfig();
    const qs = new URLSearchParams();
    qs.set("user_id", `eq.${args.user_id}`);
    qs.set("status", "eq.active");
    qs.set("order", "created_at.asc");
    qs.set("limit", String(MAX_LISTS));
    qs.set("select", "*");
    const res = await fetch(`${url}/rest/v1/lists?${qs.toString()}`, {
      headers: adminHeaders(serviceRoleKey),
      cache: "no-store",
    });
    if (!res.ok) return [];
    return (await res.json()) as ListRow[];
  } catch (e) {
    console.error("listLists threw:", e instanceof Error ? e.message : e);
    return [];
  }
}

export async function createList(args: {
  user_id: string;
  contractor_id?: string | null;
  title: string;
  kind?: ListKind;
}): Promise<ListRow | null> {
  try {
    const { url, serviceRoleKey } = getSupabaseAdminConfig();
    const row = {
      user_id: args.user_id,
      contractor_id: args.contractor_id ?? null,
      title: args.title.slice(0, 60),
      kind: args.kind ?? "custom",
    };
    const res = await fetch(`${url}/rest/v1/lists`, {
      method: "POST",
      headers: {
        ...adminHeaders(serviceRoleKey),
        Prefer: "return=representation",
      },
      body: JSON.stringify([row]),
    });
    if (!res.ok) {
      console.error("lists insert failed:", res.status, await res.text());
      return null;
    }
    const rows = (await res.json()) as ListRow[];
    return rows[0] ?? null;
  } catch (e) {
    console.error("createList threw:", e instanceof Error ? e.message : e);
    return null;
  }
}

/**
 * Rename an existing list (G live-ride 2026-07-06: "call this list Contractors
 * Needed... 6 should be able to change it for the user"). Owner-scoped by
 * user_id so a rename can never touch someone else's list. Fail-soft null.
 */
export async function renameList(args: {
  user_id: string;
  list_id: string;
  title: string;
}): Promise<ListRow | null> {
  try {
    const { url, serviceRoleKey } = getSupabaseAdminConfig();
    const qs = new URLSearchParams();
    qs.set("id", `eq.${args.list_id}`);
    qs.set("user_id", `eq.${args.user_id}`);
    const res = await fetch(`${url}/rest/v1/lists?${qs.toString()}`, {
      method: "PATCH",
      headers: {
        ...adminHeaders(serviceRoleKey),
        Prefer: "return=representation",
      },
      body: JSON.stringify({ title: args.title.slice(0, 60) }),
    });
    if (!res.ok) {
      console.error("renameList failed:", res.status, await res.text());
      return null;
    }
    const rows = (await res.json()) as ListRow[];
    return rows[0] ?? null;
  } catch (e) {
    console.error("renameList threw:", e instanceof Error ? e.message : e);
    return null;
  }
}

export async function getListById(args: {
  user_id: string;
  list_id: string;
}): Promise<ListRow | null> {
  try {
    const { url, serviceRoleKey } = getSupabaseAdminConfig();
    const qs = new URLSearchParams();
    qs.set("id", `eq.${args.list_id}`);
    qs.set("user_id", `eq.${args.user_id}`);
    qs.set("status", "eq.active");
    qs.set("select", "*");
    qs.set("limit", "1");
    const res = await fetch(`${url}/rest/v1/lists?${qs.toString()}`, {
      headers: adminHeaders(serviceRoleKey),
      cache: "no-store",
    });
    if (!res.ok) return null;
    const rows = (await res.json()) as ListRow[];
    return rows[0] ?? null;
  } catch (e) {
    console.error("getListById threw:", e instanceof Error ? e.message : e);
    return null;
  }
}

/**
 * Resolve the target list for a spoken command. A named target ("house",
 * "Henderson job") matches an existing active list by title (case-insensitive
 * substring, both directions). Add commands can opt into auto-create — saying
 * "add paint to my Henderson list" the first time just works — but read/remove
 * /complete/clear MUST pass createIfMissing:false so they don't silently create
 * an empty list and pretend the user's old list was empty.
 */
export async function resolveTargetList(args: {
  user_id: string;
  contractor_id?: string | null;
  list_name?: string | null;
  createIfMissing?: boolean;
}): Promise<ListRow | null> {
  try {
    const existing = await listLists({ user_id: args.user_id });
    const createIfMissing = args.createIfMissing !== false;
    const wanted = args.list_name?.trim();
    if (wanted) {
      const lower = wanted.toLowerCase();
      const hit = existing.find((l) => {
        const t = l.title.toLowerCase();
        return t.includes(lower) || lower.includes(t.replace(/\s+list$/i, ""));
      });
      if (hit) return hit;
      if (!createIfMissing) return null;
      if (existing.length >= MAX_LISTS) return existing[0] ?? null;
      // Title-case the spoken name ("henderson job" -> "Henderson Job").
      const title = wanted
        .split(/\s+/)
        .map((w) => (w ? w[0].toUpperCase() + w.slice(1) : w))
        .join(" ");
      const kind: ListKind = /\bjob\b/i.test(wanted)
        ? "job"
        : /\bhouse|home\b/i.test(wanted)
          ? "house"
          : /\bshop|supply|material|grocer/i.test(wanted)
            ? "shopping"
            : "custom";
      return createList({
        user_id: args.user_id,
        contractor_id: args.contractor_id ?? null,
        title,
        kind,
      });
    }
    const dflt = existing.find((l) => /\bto[- ]?do\b/i.test(l.title));
    if (dflt) return dflt;
    if (!createIfMissing) return null;
    if (existing.length >= MAX_LISTS) return existing[0] ?? null;
    return createList({
      user_id: args.user_id,
      contractor_id: args.contractor_id ?? null,
      title: DEFAULT_LIST_TITLE,
      kind: "todo",
    });
  } catch (e) {
    console.error(
      "resolveTargetList threw:",
      e instanceof Error ? e.message : e,
    );
    return null;
  }
}

/** Open items of a list, in the exact order 6 speaks them (position, then
 * created). Ordinal commands resolve against this same order. */
export async function listOpenItems(args: {
  list_id: string;
  user_id: string;
}): Promise<ListItemRow[]> {
  try {
    const { url, serviceRoleKey } = getSupabaseAdminConfig();
    const qs = new URLSearchParams();
    qs.set("list_id", `eq.${args.list_id}`);
    qs.set("user_id", `eq.${args.user_id}`);
    qs.set("status", "eq.open");
    qs.set("order", "position.asc,created_at.asc");
    qs.set("limit", String(MAX_ITEMS_PER_LIST));
    qs.set("select", "*");
    const res = await fetch(`${url}/rest/v1/list_items?${qs.toString()}`, {
      headers: adminHeaders(serviceRoleKey),
      cache: "no-store",
    });
    if (!res.ok) return [];
    return (await res.json()) as ListItemRow[];
  } catch (e) {
    console.error("listOpenItems threw:", e instanceof Error ? e.message : e);
    return [];
  }
}

/** Append items (already sanity-filtered by the caller). Dedupes against the
 * list's open items case-insensitively — saying "add milk" twice never makes
 * two milks (aiASAP behavior). Returns the rows actually inserted. */
export async function addItems(args: {
  list: ListRow;
  user_id: string;
  titles: string[];
}): Promise<ListItemRow[]> {
  try {
    const { url, serviceRoleKey } = getSupabaseAdminConfig();
    const open = await listOpenItems({
      list_id: args.list.id,
      user_id: args.user_id,
    });
    const have = new Set(open.map((i) => i.title.trim().toLowerCase()));
    const room = Math.max(0, MAX_ITEMS_PER_LIST - open.length);
    const fresh: string[] = [];
    for (const raw of args.titles) {
      const title = raw.trim().slice(0, MAX_ITEM_CHARS);
      if (!title) continue;
      const key = title.toLowerCase();
      // Dedupe against both existing rows AND earlier items in the same spoken
      // utterance ("milk and milk" must insert one milk, not two).
      if (have.has(key)) continue;
      have.add(key);
      fresh.push(title);
      if (fresh.length >= room) break;
    }
    if (fresh.length === 0) return [];
    let pos = open.length > 0 ? open[open.length - 1].position + 1 : 1;
    const rows = fresh.map((title) => ({
      list_id: args.list.id,
      user_id: args.user_id,
      title,
      position: pos++,
      context: { intake: "voice" },
    }));
    const res = await fetch(`${url}/rest/v1/list_items`, {
      method: "POST",
      headers: {
        ...adminHeaders(serviceRoleKey),
        Prefer: "return=representation",
      },
      body: JSON.stringify(rows),
    });
    if (!res.ok) {
      console.error("list_items insert failed:", res.status, await res.text());
      return [];
    }
    return (await res.json()) as ListItemRow[];
  } catch (e) {
    console.error("addItems threw:", e instanceof Error ? e.message : e);
    return [];
  }
}

/** Close out an item — 'done' (finished) or 'dropped' (removed). Rows never
 * DELETE: nothing a user said is ever lost. */
export async function setItemStatus(args: {
  item_id: string;
  user_id: string;
  status: "done" | "dropped";
}): Promise<ListItemRow | null> {
  try {
    const { url, serviceRoleKey } = getSupabaseAdminConfig();
    const patch = {
      status: args.status,
      done_at: args.status === "done" ? new Date().toISOString() : null,
    };
    const res = await fetch(
      `${url}/rest/v1/list_items?id=eq.${encodeURIComponent(
        args.item_id,
      )}&user_id=eq.${encodeURIComponent(args.user_id)}`,
      {
        method: "PATCH",
        headers: {
          ...adminHeaders(serviceRoleKey),
          Prefer: "return=representation",
        },
        body: JSON.stringify(patch),
      },
    );
    if (!res.ok) {
      console.error(
        "list_items status update failed:",
        res.status,
        await res.text(),
      );
      return null;
    }
    const rows = (await res.json()) as ListItemRow[];
    return rows[0] ?? null;
  } catch (e) {
    console.error("setItemStatus threw:", e instanceof Error ? e.message : e);
    return null;
  }
}

/** Clear the whole list in one shot (aiASAP lesson: G said "clear the list"
 * 26 times and nothing happened). Drops every open item; returns the count,
 * or -1 on failure so the caller never fakes a "cleared" confirmation. */
export async function clearList(args: {
  list_id: string;
  user_id: string;
}): Promise<number> {
  try {
    const { url, serviceRoleKey } = getSupabaseAdminConfig();
    const res = await fetch(
      `${url}/rest/v1/list_items?list_id=eq.${encodeURIComponent(
        args.list_id,
      )}&user_id=eq.${encodeURIComponent(args.user_id)}&status=eq.open`,
      {
        method: "PATCH",
        headers: {
          ...adminHeaders(serviceRoleKey),
          Prefer: "return=representation",
        },
        body: JSON.stringify({ status: "dropped" }),
      },
    );
    if (!res.ok) {
      console.error("list clear failed:", res.status, await res.text());
      return -1;
    }
    const rows = (await res.json()) as unknown[];
    return rows.length;
  } catch (e) {
    console.error("clearList threw:", e instanceof Error ? e.message : e);
    return -1;
  }
}

/**
 * The contractors row this user has claimed, if any — links a trade-pro's
 * lists to their business profile. Fail-soft: any error means "not a
 * contractor" and the list saves user-scoped only.
 */
export async function findClaimedContractorId(
  user_id: string,
): Promise<string | null> {
  try {
    const { url, serviceRoleKey } = getSupabaseAdminConfig();
    const res = await fetch(
      `${url}/rest/v1/contractors?claimed_by_user_id=eq.${encodeURIComponent(
        user_id,
      )}&select=id&limit=1`,
      { headers: adminHeaders(serviceRoleKey), cache: "no-store" },
    );
    if (!res.ok) return null;
    const rows = (await res.json()) as Array<{ id: string }>;
    return rows[0]?.id ?? null;
  } catch {
    return null;
  }
}
