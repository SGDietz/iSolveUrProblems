// SUP #22 (G ride 2026-07-07 16:55: "Hey, Six, make the text bigger" got a
// flat "I can't change the text size"). Voice-adjustable list text size,
// modeled on aiASAP's uiSize. Levels index TODO_TEXT_SIZE_CLASSES; the
// default level matches the compact sheet's existing 0.9rem so nothing
// changes visually until the user asks (gold-standard rule #1.5).

export const UI_SIZE_BIGGER_RE =
  /\b(?:make|turn)\b[^.?!]{0,30}\b(?:list|items?|text|writing|words?|letters?|font|everything|it|them|this|that)\b[^.?!]{0,24}\b(?:bigger|larger|huge)\b|\b(?:bigger|larger)\s+(?:list|items?|text|font|letters?|words?)\b|\bcan'?t (?:read|see)\b[^.?!]{0,24}\b(?:it|that|them|the|this|what)\b|\btoo small to read\b|\b(?:need|wear|forgot|without)\b[^.?!]{0,20}\breading\s+glasses\b|^\W*(?:even\s+|much\s+|way\s+|a\s+lot\s+|still\s+)?(?:bigger|larger)[.!\s]*$/i;

/** Font multiplier per level — level 1 is the untouched default look. */
export const TEXT_SIZE_FACTORS = [0.88, 1, 1.16, 1.32] as const;

export const UI_SIZE_SMALLER_RE =
  /\b(?:make|turn)\b[^.?!]{0,30}\b(?:list|items?|text|writing|words?|letters?|font|everything|it|them|this|that)\b[^.?!]{0,24}\b(?:smaller|tinier)\b|\b(?:smaller|tinier)\s+(?:list|items?|text|font|letters?|words?)\b|\b(?:text|words?|letters?|writing) (?:is|are) too big\b|^\W*(?:even\s+|much\s+|way\s+|a\s+lot\s+|still\s+)?(?:smaller|tinier)[.!\s]*$/i;

export const TODO_TEXT_SIZE_STORAGE_KEY = "isolve.todoTextSizeLevel.v1";
export const TODO_TEXT_SIZE_CLASSES = [
  "text-[0.82rem]",
  "text-[0.9rem]",
  "text-[1.05rem]",
  "text-[1.18rem]",
] as const;
export const TODO_TEXT_SIZE_DEFAULT_LEVEL = 1;
export const TODO_TEXT_SIZE_MAX_LEVEL = TODO_TEXT_SIZE_CLASSES.length - 1;

export function loadTodoTextSizeLevel(): number {
  if (typeof window === "undefined") return TODO_TEXT_SIZE_DEFAULT_LEVEL;
  try {
    const raw = window.localStorage.getItem(TODO_TEXT_SIZE_STORAGE_KEY);
    const n = raw === null ? TODO_TEXT_SIZE_DEFAULT_LEVEL : parseInt(raw, 10);
    return Number.isFinite(n) && n >= 0 && n <= TODO_TEXT_SIZE_MAX_LEVEL
      ? n
      : TODO_TEXT_SIZE_DEFAULT_LEVEL;
  } catch {
    return TODO_TEXT_SIZE_DEFAULT_LEVEL;
  }
}
