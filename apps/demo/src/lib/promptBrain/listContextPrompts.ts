// aiASAP-derived prompt-brain list context for iSolve/SUP.
// When a visible list is on 6's chest, the prompt pills must become things
// people can actually do with THAT list, not stale repair defaults.

export type PromptBrainListContext = { title: string; items: string[] };

const MAX_PROMPT_BRAIN_LIST_ITEMS = 80;

const SHOPPING_LIST_RE =
  /\b(?:walmart|grocery|groceries|shopping|store|market|costco|target|aldi|trader joe|food|supplies|hardware|home depot|lowe'?s)\b/i;
const TODO_LIST_RE = /\b(?:todo|to-do|task|tasks|errand|errands|checklist|punch\s*list)\b/i;
const REPAIR_LIST_RE =
  /\b(?:repair|fix|home|house|project|contractor|pros?|plumber|painter|electrician|roofer|hvac|yard|lawn|handyman)\b/i;
const GIFT_LIST_RE = /\b(?:gift|birthday|christmas|holiday|present|presents)\b/i;
const TRAVEL_LIST_RE = /\b(?:travel|trip|vacation|pack|packing|beach|flight|hotel)\b/i;

function compact(value: unknown, maxChars: number): string | null {
  if (typeof value !== "string") return null;
  const cleaned = value.replace(/\s+/g, " ").trim();
  if (!cleaned) return null;
  return cleaned.length > maxChars ? cleaned.slice(0, maxChars).trim() : cleaned;
}

export function normalizeListContext(
  value: unknown,
): PromptBrainListContext | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const raw = value as { title?: unknown; items?: unknown };
  const title = compact(raw.title, 80) || "List";
  const items = Array.isArray(raw.items)
    ? raw.items
        .map((item) => compact(item, 60))
        .filter((item): item is string => Boolean(item))
        .slice(0, MAX_PROMPT_BRAIN_LIST_ITEMS)
    : [];
  if (!title && items.length === 0) return null;
  return { title, items };
}

function listIncludes(items: string[], candidate: string): boolean {
  const wanted = candidate.toLowerCase();
  return items.some((item) => item.toLowerCase().includes(wanted));
}

function addMissing(items: string[], candidates: string[]): string[] {
  return candidates
    .filter((candidate) => !listIncludes(items, candidate))
    .map((candidate) => `Add ${candidate}`);
}

function missingActions(items: string[], candidates: string[]): string[] {
  return candidates.filter((candidate) => !listIncludes(items, candidate));
}

function dedupe(prompts: string[]): string[] {
  const seen = new Set<string>();
  return prompts.filter((prompt) => {
    const key = prompt.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export function getListContextPrompts(
  context: PromptBrainListContext,
): string[] {
  const haystack = `${context.title} ${context.items.join(" ")}`;
  let prompts: string[];

  if (SHOPPING_LIST_RE.test(haystack)) {
    prompts = [
      ...addMissing(context.items, [
        "Toothpaste",
        "Milk",
        "Eggs",
        "Bread",
        "Coffee",
        "Paper Towels",
      ]).slice(0, 2),
      "Find Deals",
    ];
  } else if (REPAIR_LIST_RE.test(haystack)) {
    prompts = [
      ...missingActions(context.items, [
        "Get Estimate",
        "Take Photo",
        "Measure It",
      ]).slice(0, 2),
      "Find Pros",
    ];
  } else if (TODO_LIST_RE.test(haystack)) {
    prompts = ["Next Task", "Set Priority", "Add Deadline"];
  } else if (GIFT_LIST_RE.test(haystack)) {
    prompts = ["Gift Ideas", "Set Budget", "Add a Card"];
  } else if (TRAVEL_LIST_RE.test(haystack)) {
    prompts = ["Pack Shoes", "Add Sunscreen", "Check Tickets"];
  } else {
    prompts = ["Add Item", "Name List", "Read It Back"];
  }

  // Return more than iSolve's 3 visible pills so the route sanitizer can drop
  // duplicates/blocked labels without falling back to unrelated repair pills.
  return dedupe([
    ...prompts,
    "Check List",
    "Add Item",
    "Name List",
    "Read It Back",
  ]).slice(0, 6);
}
