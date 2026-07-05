import { notFound, redirect } from "next/navigation";
import { setRequestLocale, getTranslations } from "next-intl/server";
import { Link } from "../../../../../../src/i18n/routing";
import { getUserId } from "../../../../../../src/lib/auth/getUser";
import { getSupabaseAdminConfig } from "../../../../../../src/lib/supabaseAdmin";
import { getActiveTierForContractor } from "../../../../../../src/lib/billing/store";
import { tierUnlocks } from "../../../../../../src/lib/billing/tiers";
import { listJobLogsWithUrls } from "../../../../../../src/lib/jobLogs";
import { JobLogCapture } from "../../../../../../src/components/contractor/JobLogCapture";

export const dynamic = "force-dynamic";

/**
 * M4.5 — Contractor job-log capture page.
 *
 * Mobile-first surface the contractor opens on their phone when on-site.
 * Authenticated; only the claimed contractor for the appointment can
 * land here. Homeowners get redirected to the regular dashboard.
 */

type ApptSummary = {
  id: string;
  scheduled_at: string;
  agenda: string;
  contractor_id: string;
  user_id: string;
};

async function fetchAppointmentBasic(
  appointment_id: string,
): Promise<ApptSummary | null> {
  const { url, serviceRoleKey } = getSupabaseAdminConfig();
  const res = await fetch(
    `${url}/rest/v1/appointments?id=eq.${encodeURIComponent(
      appointment_id,
    )}&select=id,scheduled_at,agenda,contractor_id,user_id&limit=1`,
    {
      headers: {
        apikey: serviceRoleKey,
        Authorization: `Bearer ${serviceRoleKey}`,
      },
      cache: "no-store",
    },
  );
  if (!res.ok) return null;
  const rows = (await res.json()) as ApptSummary[];
  return rows[0] ?? null;
}

async function fetchClaimedContractorId(
  userId: string,
): Promise<string | null> {
  const { url, serviceRoleKey } = getSupabaseAdminConfig();
  const res = await fetch(
    `${url}/rest/v1/users?id=eq.${encodeURIComponent(
      userId,
    )}&select=contractor_id&limit=1`,
    {
      headers: {
        apikey: serviceRoleKey,
        Authorization: `Bearer ${serviceRoleKey}`,
      },
      cache: "no-store",
    },
  );
  if (!res.ok) return null;
  const rows = (await res.json()) as Array<{ contractor_id: string | null }>;
  return rows[0]?.contractor_id ?? null;
}

export default async function JobLogPage({
  params,
}: {
  params: Promise<{ locale: string; id: string }>;
}) {
  const { locale, id } = await params;
  setRequestLocale(locale);
  const t = await getTranslations("contractor.jobLog");
  const userId = await getUserId();
  if (!userId) {
    redirect(
      `/${locale}/auth/sign-in?next=/${locale}/contractor/jobs/${id}/log`,
    );
  }

  const [appt, contractorId] = await Promise.all([
    fetchAppointmentBasic(id),
    fetchClaimedContractorId(userId),
  ]);
  if (!appt) notFound();
  if (!contractorId || contractorId !== appt.contractor_id) {
    // Not the contractor for this appointment.
    redirect(`/${locale}/contractor/dashboard`);
  }

  const tier = await getActiveTierForContractor(appt.contractor_id);
  const gated = !tierUnlocks(tier, "photo_log");
  const entries = await listJobLogsWithUrls({ appointment_id: id });
  const when = new Date(appt.scheduled_at).toLocaleString();

  return (
    <main className="w-full max-w-xl flex flex-col gap-5 px-4 py-8">
      <header className="flex flex-col gap-1">
        <p className="text-[11px] uppercase tracking-[0.2em] text-amber-300">
          {t("kicker")}
        </p>
        <h1 className="text-xl font-semibold text-zinc-100">{appt.agenda || t("untitledAgenda")}</h1>
        <p className="text-xs text-zinc-500 font-mono">{when}</p>
      </header>

      {gated ? (
        <section className="rounded-lg border border-amber-900/40 bg-zinc-950/40 p-3 flex flex-col gap-1.5 text-sm">
          <p className="text-amber-200 font-semibold">{t("gatedTitle")}</p>
          <p className="text-xs text-zinc-300">{t("gatedBlurb")}</p>
          <Link
            href="/contractor/dashboard"
            className="text-xs text-amber-300 underline self-start mt-1"
          >
            {t("gatedManageCta")}
          </Link>
        </section>
      ) : (
        <JobLogCapture appointment_id={id} initial_entries={entries} />
      )}

      <Link
        href="/contractor/dashboard"
        className="text-sm text-zinc-400 hover:text-zinc-200 underline self-start"
      >
        {t("backToDashboard")}
      </Link>
    </main>
  );
}
