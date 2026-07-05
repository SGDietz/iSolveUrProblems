/**
 * 6-led lists (G 2026-07-01) — ported from aiASAP's list system (read-only
 * source: ai-asap-may06-prod), rebuilt on Supabase tables instead of
 * user_metadata. Mirrors 20260701_lists.sql.
 *
 * Kinds map to the marketplace:
 *   todo     — the default personal list
 *   house    — homeowner's running "stuff my house needs" (each item can
 *              become a job)
 *   job      — a contractor's per-job punch list ("what the Henderson job
 *              needs")
 *   shopping — materials/supply-run list
 *   custom   — anything the user names
 */

export type ListKind = "todo" | "house" | "job" | "shopping" | "custom";
export type ListStatus = "active" | "archived";
export type ListItemStatus = "open" | "done" | "dropped";

export type ListRow = {
  id: string;
  user_id: string;
  contractor_id: string | null;
  title: string;
  kind: ListKind;
  status: ListStatus;
  context: Record<string, unknown>;
  created_at: string;
  updated_at: string;
};

export type ListItemRow = {
  id: string;
  list_id: string;
  user_id: string;
  title: string;
  details: string;
  status: ListItemStatus;
  position: number;
  due_at: string | null;
  done_at: string | null;
  media_event_id: string | null;
  context: Record<string, unknown>;
  created_at: string;
  updated_at: string;
};

// aiASAP-proven caps (accountPersistence.ts): keep lists spoken-sized.
export const MAX_LISTS = 30;
export const MAX_ITEMS_PER_LIST = 100;
export const MAX_ITEM_CHARS = 80;
