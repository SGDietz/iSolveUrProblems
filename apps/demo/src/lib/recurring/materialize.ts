import { expandInstances } from "./rrule";
import {
  insertMaterializedAppointment,
  listActiveRecurringJobs,
  patchRecurringJob,
  type RecurringJobRow,
} from "./store";

/**
 * M4.7 — Materialization pass.
 *
 * For every active recurring_jobs row, expand the next N days of the
 * RRULE and insert any instance that doesn't already exist as an
 * appointment. v1 window = 7 days; cron runs nightly so a missed run
 * (or two) doesn't lose instances.
 *
 * Idempotent via the unique index on (recurring_job_id, scheduled_at) —
 * `insertMaterializedAppointment` uses `resolution=ignore-duplicates`.
 *
 * Auto-ends jobs that pass `active_until`. Sets `last_materialized_at`
 * for cron observability.
 */

export type MaterializeStats = {
  jobs_walked: number;
  appointments_materialized: number;
  jobs_ended: number;
  errors: number;
};

const DEFAULT_WINDOW_DAYS = 7;

export async function materializeRecurringJobs(args?: {
  window_days?: number;
  /** Override "now" for tests. */
  now?: Date;
}): Promise<MaterializeStats> {
  const now = args?.now ?? new Date();
  const windowDays = args?.window_days ?? DEFAULT_WINDOW_DAYS;
  const to = new Date(now.getTime() + windowDays * 86_400_000);

  const jobs = await listActiveRecurringJobs({ limit: 1000 });
  const stats: MaterializeStats = {
    jobs_walked: jobs.length,
    appointments_materialized: 0,
    jobs_ended: 0,
    errors: 0,
  };

  for (const job of jobs) {
    try {
      // active_until reached? Mark ended and skip.
      if (job.active_until && new Date(job.active_until).getTime() < now.getTime()) {
        await patchRecurringJob(job.id, { status: "ended" });
        stats.jobs_ended += 1;
        continue;
      }

      const anchor = new Date(job.active_from);
      const instances = expandInstances({
        schedule: job.schedule,
        timezone: job.timezone,
        anchor,
        from: now,
        to,
      });

      for (const iso of instances) {
        const inserted = await insertMaterializedAppointment({
          user_id: job.user_id,
          contractor_id: job.contractor_id,
          contract_id: job.contract_id,
          recurring_job_id: job.id,
          scheduled_at: iso,
          duration_minutes: job.duration_minutes,
          agenda: job.agenda,
        });
        if (inserted) stats.appointments_materialized += 1;
      }

      await patchRecurringJob(job.id, {
        last_materialized_at: new Date().toISOString(),
      });
    } catch (e) {
      stats.errors += 1;
      console.error("[recurring/materialize] job failed:", job.id, e);
    }
  }

  return stats;
}

/**
 * Watchdog — finds active recurring jobs whose `last_materialized_at`
 * is stale (>= 36h) OR null. Useful for alerting if the cron stops
 * firing. Not called from the cron itself; intended for an admin
 * dashboard health check.
 */
export async function findStaleRecurringJobs(args?: {
  staleAfterHours?: number;
}): Promise<RecurringJobRow[]> {
  const jobs = await listActiveRecurringJobs({ limit: 1000 });
  const cutoff = Date.now() - (args?.staleAfterHours ?? 36) * 3_600_000;
  return jobs.filter((j) => {
    if (!j.last_materialized_at) return true;
    return new Date(j.last_materialized_at).getTime() < cutoff;
  });
}
