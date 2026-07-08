/**
 * M4.7 — Natural-language recurring-schedule parser.
 *
 * Converts homeowner phrases into RRULE-shaped JSON. Same approach as
 * M3.4 extractDateTime — rules-based, narrow set of patterns. v2 can
 * layer an LLM disambiguator on top without changing the consumer
 * (orchestrator + cron) of this module.
 *
 * Supported shapes (English v1):
 *   - "every Tuesday at 10am"                    → weekly TU 10:00
 *   - "every other Friday at 9"                  → weekly FR INTERVAL=2 09:00
 *   - "every Monday and Wednesday at 3pm"        → weekly MO,WE 15:00
 *   - "weekly on Tuesdays at 10am"               → weekly TU 10:00
 *   - "every month on the 15th"                  → monthly BYMONTHDAY=15
 *   - "monthly at 9am"                           → monthly BYMONTHDAY=anchor.day 09:00
 *   - "daily at 7am"                             → daily 07:00
 *   - "...from May through October"              → BYMONTH=[5..10]
 *   - "...from May 15 to October 31"             → UNTIL=YYYY-10-31
 *   - "...for the next 12 weeks"                 → COUNT=12 (weekly)
 *   - "...until Christmas"                       → UNTIL=YYYY-12-25
 *
 * Returns null if no recurring pattern is recognized — caller falls
 * back to the regular one-shot scheduling path.
 */

import type { RecurringSchedule } from "./rrule";

const DAY_MAP: Record<string, "SU" | "MO" | "TU" | "WE" | "TH" | "FR" | "SA"> = {
  sunday: "SU", monday: "MO", tuesday: "TU", wednesday: "WE",
  thursday: "TH", friday: "FR", saturday: "SA",
  sun: "SU", mon: "MO", tue: "TU", tues: "TU", wed: "WE",
  thu: "TH", thur: "TH", thurs: "TH", fri: "FR", sat: "SA",
};

const MONTH_NAME_TO_NUM: Record<string, number> = {
  january: 1, february: 2, march: 3, april: 4, may: 5, june: 6,
  july: 7, august: 8, september: 9, october: 10, november: 11, december: 12,
  jan: 1, feb: 2, mar: 3, apr: 4, jun: 6, jul: 7, aug: 8, sep: 9,
  sept: 9, oct: 10, nov: 11, dec: 12,
};

function parseHour(raw: string): { hour: number; minute: number } | null {
  const m = raw.match(/(\d{1,2})(?::(\d{2}))?\s*(am|pm|a\.m\.|p\.m\.)?/i);
  if (!m) return null;
  let hour = parseInt(m[1], 10);
  const minute = m[2] ? parseInt(m[2], 10) : 0;
  const ampm = m[3]?.toLowerCase().replace(/\./g, "");
  if (hour < 0 || hour > 23 || minute < 0 || minute > 59) return null;
  if (ampm === "pm" && hour < 12) hour += 12;
  if (ampm === "am" && hour === 12) hour = 0;
  if (!ampm && hour >= 1 && hour <= 7) hour += 12; // "at 3" → 3pm
  return { hour, minute };
}

function findDays(text: string): Array<"SU" | "MO" | "TU" | "WE" | "TH" | "FR" | "SA"> {
  const out = new Set<"SU" | "MO" | "TU" | "WE" | "TH" | "FR" | "SA">();
  const re = /\b(sun(?:day)?|mon(?:day)?|tue(?:s|sday)?|wed(?:nesday)?|thu(?:r|rs|rsday)?|fri(?:day)?|sat(?:urday)?)s?\b/gi;
  for (const m of text.matchAll(re)) {
    const key = m[1].toLowerCase().replace(/s$/, "");
    const day = DAY_MAP[key];
    if (day) out.add(day);
  }
  return [...out];
}

function findMonthRange(text: string): number[] | null {
  // "from May through October", "May to October", "May - October"
  const re =
    /\b(?:from\s+)?(january|february|march|april|may|june|july|august|september|october|november|december|jan|feb|mar|apr|jun|jul|aug|sep|sept|oct|nov|dec)\s+(?:through|to|–|—|-)\s+(january|february|march|april|may|june|july|august|september|october|november|december|jan|feb|mar|apr|jun|jul|aug|sep|sept|oct|nov|dec)\b/i;
  const m = text.match(re);
  if (!m) return null;
  const a = MONTH_NAME_TO_NUM[m[1].toLowerCase()];
  const b = MONTH_NAME_TO_NUM[m[2].toLowerCase()];
  if (!a || !b) return null;
  const out: number[] = [];
  if (a <= b) {
    for (let i = a; i <= b; i++) out.push(i);
  } else {
    // Wraparound: "from November through February" → [11,12,1,2]
    for (let i = a; i <= 12; i++) out.push(i);
    for (let i = 1; i <= b; i++) out.push(i);
  }
  return out;
}

function findCount(text: string): number | null {
  // "for the next 12 weeks", "for 8 weeks", "12 times"
  const re = /\b(?:for\s+(?:the\s+next\s+)?)?(\d{1,3})\s+(?:more\s+)?(?:weeks?|times?|months?|days?|sessions?|visits?)\b/i;
  const m = text.match(re);
  if (!m) return null;
  const n = parseInt(m[1], 10);
  if (n < 1 || n > 500) return null;
  return n;
}

function findUntil(text: string, now: Date): string | null {
  // "until October 31", "until Christmas", "until 2026-10-31"
  // v1: only the explicit month-day path. "Christmas" / holidays → defer.
  const re =
    /\buntil\s+(january|february|march|april|may|june|july|august|september|october|november|december|jan|feb|mar|apr|jun|jul|aug|sep|sept|oct|nov|dec)\s+(\d{1,2})\b/i;
  const m = text.match(re);
  if (!m) return null;
  const monthNum = MONTH_NAME_TO_NUM[m[1].toLowerCase()];
  const day = parseInt(m[2], 10);
  if (!monthNum || day < 1 || day > 31) return null;
  let year = now.getUTCFullYear();
  const candidate = new Date(Date.UTC(year, monthNum - 1, day));
  // If the date has passed this year, roll to next year.
  if (candidate.getTime() < now.getTime()) {
    year += 1;
    candidate.setUTCFullYear(year);
  }
  return candidate.toISOString();
}

export type ParsedSchedule = {
  schedule: RecurringSchedule;
  matched_phrase: string;
};

export function parseRecurringSchedule(
  text: string,
  now: Date = new Date(),
): ParsedSchedule | null {
  const t = text.toLowerCase();
  if (!/\b(every|each|weekly|monthly|daily|recurring|each\s+(week|month|day))\b/i.test(t)) {
    return null;
  }

  // Resolve interval (default 1, "every other" = 2)
  const interval = /\bevery\s+other\b/.test(t) ? 2 : 1;

  // Clock time — default 9am if none stated.
  const clockMatch = t.match(
    /\bat\s+(\d{1,2}(?::\d{2})?\s*(?:am|pm|a\.m\.|p\.m\.)?)\b/i,
  );
  const clock = clockMatch ? parseHour(clockMatch[1]) : null;
  const byhour = clock?.hour ?? 9;
  const byminute = clock?.minute ?? 0;

  // Termination
  const until = findUntil(text, now);
  const count = findCount(text);

  // Month range
  const bymonth = findMonthRange(text) ?? undefined;

  // FREQ + BYDAY / BYMONTHDAY detection
  const days = findDays(t);
  const isMonthly =
    /\b(monthly|every\s+month|each\s+month|month\s+on)\b/i.test(t);
  const isDaily =
    /\b(daily|every\s+day|each\s+day)\b/i.test(t) && days.length === 0;

  let schedule: RecurringSchedule | null = null;

  if (isMonthly) {
    // BYMONTHDAY — "on the 15th"
    const dayMatch = t.match(/\bon\s+the\s+(\d{1,2})(?:st|nd|rd|th)?\b/);
    const monthday = dayMatch ? parseInt(dayMatch[1], 10) : null;
    schedule = {
      freq: "MONTHLY",
      interval,
      bymonthday:
        monthday && monthday >= 1 && monthday <= 31 ? [monthday] : undefined,
      bymonth,
      byhour,
      byminute,
      until,
      count: count ?? null,
    };
  } else if (isDaily) {
    schedule = {
      freq: "DAILY",
      interval,
      bymonth,
      byhour,
      byminute,
      until,
      count: count ?? null,
    };
  } else if (days.length > 0) {
    schedule = {
      freq: "WEEKLY",
      interval,
      byday: days,
      bymonth,
      byhour,
      byminute,
      until,
      count: count ?? null,
    };
  } else if (/\bweekly\b/.test(t)) {
    // Plain "weekly" with no day named → fall back to today's weekday
    // at the parse time. The orchestrator can override this.
    const dows = ["SU", "MO", "TU", "WE", "TH", "FR", "SA"] as const;
    schedule = {
      freq: "WEEKLY",
      interval,
      byday: [dows[now.getUTCDay()]],
      bymonth,
      byhour,
      byminute,
      until,
      count: count ?? null,
    };
  }

  if (!schedule) return null;

  return {
    schedule,
    matched_phrase: text.trim(),
  };
}
