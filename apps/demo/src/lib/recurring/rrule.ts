/**
 * M4.7 — Minimal RRULE expander.
 *
 * Subset of iCalendar RFC 5545. Supports exactly the patterns the M4.7
 * natural-language parser produces:
 *
 *   - FREQ in {DAILY, WEEKLY, MONTHLY}
 *   - INTERVAL (every N units)
 *   - BYDAY for WEEKLY (e.g. ["MO","TU"])
 *   - BYMONTHDAY for MONTHLY (e.g. [1, 15])
 *   - BYMONTH (e.g. [5,6,7,8,9,10] for May-Oct)
 *   - BYHOUR + BYMINUTE (single value each — the wall-clock time)
 *   - UNTIL or COUNT (termination)
 *
 * Critically: BYHOUR/BYMINUTE are interpreted in the schedule's
 * `timezone` (IANA), so DST doesn't drift a 10am-every-Tuesday job.
 *
 * Expansion is bounded — `expandInstances(from, to)` returns the
 * UTC ISO timestamps of every instance whose wall-clock time falls
 * inside [from, to]. The cron uses this with a 7-day window to keep
 * materialization fast.
 */

export type RruleFreq = "DAILY" | "WEEKLY" | "MONTHLY";

export type RecurringSchedule = {
  freq: RruleFreq;
  interval: number;                          // default 1
  byday?: ReadonlyArray<"SU" | "MO" | "TU" | "WE" | "TH" | "FR" | "SA">;
  bymonthday?: ReadonlyArray<number>;        // 1..31
  bymonth?: ReadonlyArray<number>;           // 1..12
  byhour: number;                            // 0..23
  byminute: number;                          // 0..59
  until?: string | null;                     // ISO UTC
  count?: number | null;
};

const DAY_TO_DOW: Record<string, number> = {
  SU: 0, MO: 1, TU: 2, WE: 3, TH: 4, FR: 5, SA: 6,
};

// ─── Timezone helpers (mirrored from appointments/extractDateTime so
// recurring stays self-contained) ───────────────────────────────────

function isValidTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

type ZonedParts = {
  year: number;
  month: number; // 0-indexed
  day: number;
  hour: number;
  minute: number;
  dayOfWeek: number; // 0=Sun..6=Sat
};

const WEEKDAY_SHORT: Record<string, number> = {
  sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6,
};

function getZonedParts(date: Date, tz: string): ZonedParts {
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    weekday: "short",
    hour12: false,
  });
  const parts = fmt.formatToParts(date);
  const lookup: Record<string, string> = {};
  for (const p of parts) lookup[p.type] = p.value;
  return {
    year: parseInt(lookup.year, 10),
    month: parseInt(lookup.month, 10) - 1,
    day: parseInt(lookup.day, 10),
    hour: lookup.hour === "24" ? 0 : parseInt(lookup.hour, 10),
    minute: parseInt(lookup.minute, 10),
    dayOfWeek:
      WEEKDAY_SHORT[(lookup.weekday ?? "").slice(0, 3).toLowerCase()] ?? 0,
  };
}

function zonedToUtc(args: {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  tz: string;
}): Date {
  const utcGuess = new Date(
    Date.UTC(args.year, args.month, args.day, args.hour, args.minute, 0),
  );
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: args.tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
  const parts = fmt.formatToParts(utcGuess);
  const lookup: Record<string, string> = {};
  for (const p of parts) lookup[p.type] = p.value;
  const displayedAsUtc = Date.UTC(
    parseInt(lookup.year, 10),
    parseInt(lookup.month, 10) - 1,
    parseInt(lookup.day, 10),
    lookup.hour === "24" ? 0 : parseInt(lookup.hour, 10),
    parseInt(lookup.minute, 10),
    0,
  );
  const offset = displayedAsUtc - utcGuess.getTime();
  return new Date(utcGuess.getTime() - offset);
}

// ─── Expander ───────────────────────────────────────────────────────

/**
 * Expand a schedule to its instances inside [from, to] (UTC).
 * Returns ISO UTC strings, sorted ascending.
 *
 * Algorithm: iterate calendar days in the schedule's tz, and for each
 * day decide whether it's an instance day by walking BYDAY / BYMONTHDAY
 * / BYMONTH / INTERVAL rules. For days that qualify, build the wall-
 * clock time at byhour:byminute, convert to UTC, and emit if inside
 * the window.
 */
export function expandInstances(args: {
  schedule: RecurringSchedule;
  timezone: string;
  from: Date;
  to: Date;
  /** Anchor of the recurring job (active_from). Determines INTERVAL phase. */
  anchor: Date;
}): string[] {
  const tz = isValidTimeZone(args.timezone) ? args.timezone : "UTC";
  const sch = args.schedule;
  const out: string[] = [];

  const until = sch.until ? new Date(sch.until) : null;
  const ceiling = until && until.getTime() < args.to.getTime() ? until : args.to;
  if (ceiling.getTime() < args.from.getTime()) return out;

  // For COUNT enforcement we need to count emissions from the anchor.
  // Walking from the anchor for every cron tick is fine for v1 (a 6-month
  // weekly job has 26 instances — trivial). For huge schedules we'd
  // cache a checkpoint; not needed at v1 volumes.
  const countLimit = sch.count ?? Infinity;
  let emittedSinceAnchor = 0;

  const anchorParts = getZonedParts(args.anchor, tz);
  let cursor = {
    year: anchorParts.year,
    month: anchorParts.month,
    day: anchorParts.day,
  };

  // Move cursor day-by-day. Hard cap to avoid runaway loops if a bad
  // schedule slips in (e.g. BYMONTHDAY=31 + BYMONTH=2).
  const MAX_DAYS_TO_WALK = 366 * 5; // 5 years of days

  for (let i = 0; i < MAX_DAYS_TO_WALK; i++) {
    if (emittedSinceAnchor >= countLimit) break;

    // Test if cursor day satisfies the rule.
    const ms = Date.UTC(cursor.year, cursor.month, cursor.day);
    const date = new Date(ms);
    const dow = date.getUTCDay();

    // BYMONTH filter
    const monthOk =
      !sch.bymonth || sch.bymonth.includes(cursor.month + 1);

    // BYDAY filter (weekly)
    const bydayOk =
      !sch.byday ||
      sch.byday.some((d) => DAY_TO_DOW[d] === dow);

    // BYMONTHDAY filter (monthly)
    const bymonthdayOk =
      !sch.bymonthday || sch.bymonthday.includes(cursor.day);

    // INTERVAL — distance from anchor in the right unit.
    const isOnInterval = (() => {
      const interval = Math.max(1, sch.interval);
      if (interval === 1) return true;
      if (sch.freq === "DAILY") {
        const diffDays = Math.round(
          (ms - Date.UTC(anchorParts.year, anchorParts.month, anchorParts.day)) /
            86_400_000,
        );
        return diffDays % interval === 0;
      }
      if (sch.freq === "WEEKLY") {
        const diffWeeks = Math.floor(
          (ms - Date.UTC(anchorParts.year, anchorParts.month, anchorParts.day)) /
            (86_400_000 * 7),
        );
        return diffWeeks % interval === 0;
      }
      if (sch.freq === "MONTHLY") {
        const monthsDiff =
          (cursor.year - anchorParts.year) * 12 +
          (cursor.month - anchorParts.month);
        return monthsDiff % interval === 0;
      }
      return true;
    })();

    let qualifies = false;
    if (sch.freq === "WEEKLY") {
      qualifies = bydayOk && monthOk && isOnInterval;
    } else if (sch.freq === "MONTHLY") {
      qualifies = bymonthdayOk && monthOk && isOnInterval;
    } else if (sch.freq === "DAILY") {
      qualifies = monthOk && isOnInterval;
    }

    if (qualifies) {
      const utc = zonedToUtc({
        year: cursor.year,
        month: cursor.month,
        day: cursor.day,
        hour: sch.byhour,
        minute: sch.byminute,
        tz,
      });
      // Emit if inside [from, to] AND not before the anchor instant.
      if (
        utc.getTime() >= args.from.getTime() &&
        utc.getTime() <= ceiling.getTime() &&
        utc.getTime() >= args.anchor.getTime()
      ) {
        out.push(utc.toISOString());
      }
      // Always count emissions from anchor (for COUNT cap) — but only
      // if the instant is at or after the anchor.
      if (utc.getTime() >= args.anchor.getTime()) {
        emittedSinceAnchor += 1;
      }
    }

    // Move cursor +1 day
    const nextMs = ms + 86_400_000;
    const nextDate = new Date(nextMs);
    cursor = {
      year: nextDate.getUTCFullYear(),
      month: nextDate.getUTCMonth(),
      day: nextDate.getUTCDate(),
    };
    // Bail early if we've walked past the ceiling.
    if (nextMs > ceiling.getTime()) break;
  }

  return out;
}
