import { notFound, redirect } from "next/navigation";
import { setRequestLocale, getTranslations } from "next-intl/server";
import { Link } from "../../../../src/i18n/routing";
import { getUserId } from "../../../../src/lib/auth/getUser";
import { getSupabaseAdminConfig } from "../../../../src/lib/supabaseAdmin";
import {
  getContractorById,
  listContractorJobs,
  type ContractorJobView,
} from "../../../../src/lib/contractors/jobs";
import {
  getActiveSubscriptionForContractor,
  type Tier,
} from "../../../../src/lib/billing";
import { tierUnlocks } from "../../../../src/lib/billing/tiers";
import { SubscriptionPanel } from "../../../../src/components/contractor/SubscriptionPanel";
import { ConnectOnboardButton } from "../../../../src/components/contractor/ConnectOnboardButton";
import { ChecklistTile } from "../../../../src/components/contractor/ChecklistTile";
import { listChecklistsForContractor } from "../../../../src/lib/appointments";

export const dynamic = "force-dynamic";

/**
 * M4.0d — Contractor dashboard shell.
 *
 * Server-rendered overview the contractor lands on after sign-in. Shows:
 *   - Verified-license badge if applicable (M4.0a license-board data)
 *   - Stripe Connect status — needs onboarding completion before payouts
 *   - Job inbox: pending invitations + active jobs + completed jobs
 *
 * Routes off this page (not in v1, scaffolded by upcoming M4.x features):
 *   - /contractor/subscription (M4.1)
 *   - /contractor/crew (M4.2)
 *   - /contractor/jobs/[id] (M4.5 photo log)
 */

type UserRoleInfo = {
  role: "homeowner" | "contractor" | "admin";
  contractor_id: string | null;
  full_name: string | null;
};

async function fetchUserRole(userId: string): Promise<UserRoleInfo | null> {
  const { url, serviceRoleKey } = getSupabaseAdminConfig();
  const res = await fetch(
    `${url}/rest/v1/users?id=eq.${encodeURIComponent(userId)}&select=role,contractor_id,full_name&limit=1`,
    {
      headers: { apikey: serviceRoleKey, Authorization: `Bearer ${serviceRoleKey}` },
      cache: "no-store",
    },
  );
  if (!res.ok) return null;
  const rows = (await res.json()) as UserRoleInfo[];
  return rows[0] ?? null;
}

export default async function ContractorDashboardPage({
  params,
}: {
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  setRequestLocale(locale);
  const t = await getTranslations("contractor.dashboard");
  const userId = await getUserId();

  if (!userId) {
    redirect(
      `/${locale}/auth/sign-in?next=/${locale}/contractor/dashboard`,
    );
  }

  const roleInfo = await fetchUserRole(userId);
  if (
    !roleInfo ||
    roleInfo.role !== "contractor" ||
    !roleInfo.contractor_id
  ) {
    // Not a contractor → redirect to claim/onboarding page
    redirect(`/${locale}/for-contractors`);
  }

  const [contractor, jobs, subscription] = await Promise.all([
    getContractorById(roleInfo.contractor_id),
    listContractorJobs({ contractor_id: roleInfo.contractor_id, limit: 30 }),
    getActiveSubscriptionForContractor(roleInfo.contractor_id),
  ]);
  if (!contractor) notFound();

  const currentTier: Tier = subscription?.tier ?? "free";
  const subscriptionCurrent = {
    tier: currentTier,
    status: subscription?.status ?? "none",
    current_period_end: subscription?.current_period_end ?? null,
    cancel_at_period_end: subscription?.cancel_at_period_end ?? false,
    trial_end: subscription?.trial_end ?? null,
  };

  const pending = jobs.filter((j) => j.contract_status === "pending");
  const active = jobs.filter(
    (j) => j.contract_status === "paid" && j.next_appointment_at !== null,
  );
  const completed = jobs.filter(
    (j) => j.contract_status === "paid" && j.next_appointment_at === null,
  );

  // M4.3 — Load checklists for any active job's next appointment so the
  // tile can render in initial state without an extra round-trip.
  const activeAppointmentIds = active
    .map((j) => j.next_appointment_id)
    .filter((x): x is string => !!x);
  const existingChecklists = activeAppointmentIds.length
    ? await listChecklistsForContractor({
        contractor_id: roleInfo.contractor_id,
        appointment_ids: activeAppointmentIds,
      })
    : [];
  const checklistByAppointmentId = new Map(
    existingChecklists.map((c) => [c.appointment_id, c] as const),
  );
  const checklistGated = !tierUnlocks(currentTier, "checklist_agent");

  const licenseVerified =
    contractor.license_status === "active" &&
    !!contractor.license_number &&
    !!contractor.license_issuing_state;

  const payoutReady = contractor.stripe_charges_enabled === true;

  return (
    <main className="w-full max-w-3xl flex flex-col gap-6 px-6 py-12">
      <header className="flex flex-col gap-2">
        <p className="text-[11px] uppercase tracking-[0.2em] text-amber-300">
          {t("kicker")}
        </p>
        <h1 className="text-2xl font-semibold text-zinc-100">{contractor.name}</h1>
        <div className="flex flex-wrap gap-2">
          {licenseVerified && (
            <span className="rounded-full bg-emerald-900/40 border border-emerald-800/60 px-3 py-0.5 text-[11px] text-emerald-200">
              {t("badge.licenseVerified", {
                license: contractor.license_number ?? "",
                state: contractor.license_issuing_state ?? "",
              })}
            </span>
          )}
          {payoutReady ? (
            <span className="rounded-full bg-emerald-900/40 border border-emerald-800/60 px-3 py-0.5 text-[11px] text-emerald-200">
              {t("badge.payoutReady")}
            </span>
          ) : (
            <span className="rounded-full bg-amber-900/40 border border-amber-800/60 px-3 py-0.5 text-[11px] text-amber-200">
              {t("badge.payoutPending")}
            </span>
          )}
        </div>
      </header>

      {!payoutReady && (
        <div className="rounded-lg border border-amber-900/60 bg-amber-950/30 p-3 flex flex-col gap-2 text-sm">
          <p className="text-amber-200 font-semibold">
            {t("onboardingBanner.title")}
          </p>
          <p className="text-zinc-200">{t("onboardingBanner.blurb")}</p>
          <ConnectOnboardButton contractor_id={contractor.id} />
        </div>
      )}

      <SubscriptionPanel
        contractor_id={contractor.id}
        current={subscriptionCurrent}
      />

      <JobsSection title={t("pending.title")} blurb={t("pending.blurb")} jobs={pending} t={t} emptyLabel={t("pending.empty")} />
      <JobsSection
        title={t("active.title")}
        blurb={t("active.blurb")}
        jobs={active}
        t={t}
        emptyLabel={t("active.empty")}
        renderExtras={(j) =>
          j.next_appointment_id && j.next_appointment_at ? (
            <div className="flex flex-col gap-2">
              <ChecklistTile
                appointment_id={j.next_appointment_id}
                scheduled_at={j.next_appointment_at}
                agenda={j.next_appointment_agenda ?? ""}
                initial_row={
                  checklistByAppointmentId.get(j.next_appointment_id) ?? null
                }
                gated={checklistGated}
              />
              <Link
                href={`/contractor/jobs/${j.next_appointment_id}/log`}
                className="text-xs text-amber-300 hover:text-amber-200 underline self-start"
              >
                {t("logWorkCta")}
              </Link>
            </div>
          ) : null
        }
      />
      <JobsSection title={t("completed.title")} blurb={t("completed.blurb")} jobs={completed} t={t} emptyLabel={t("completed.empty")} />

      <Link
        href="/"
        className="text-sm text-zinc-400 hover:text-zinc-200 underline self-start"
      >
        {t("backHome")}
      </Link>
    </main>
  );
}

function formatCents(cents: number, currency: string): string {
  try {
    return new Intl.NumberFormat(undefined, {
      style: "currency",
      currency: (currency || "USD").toUpperCase(),
      maximumFractionDigits: 2,
    }).format(cents / 100);
  } catch {
    return `$${(cents / 100).toFixed(2)}`;
  }
}

function JobsSection({
  title,
  blurb,
  jobs,
  t,
  emptyLabel,
  renderExtras,
}: {
  title: string;
  blurb: string;
  jobs: ContractorJobView[];
  // Loose-typed translator — fine because every call site below uses
  // keys that exist in the namespace.
  t: (k: string, vars?: Record<string, string | number | Date>) => string;
  emptyLabel: string;
  renderExtras?: (j: ContractorJobView) => React.ReactNode;
}) {
  return (
    <section className="flex flex-col gap-2">
      <header className="flex flex-col">
        <h2 className="text-lg font-semibold text-zinc-100">
          {title}{" "}
          <span className="text-sm text-zinc-500 font-normal">
            ({jobs.length})
          </span>
        </h2>
        <p className="text-xs text-zinc-500">{blurb}</p>
      </header>
      {jobs.length === 0 ? (
        <p className="text-sm text-zinc-500 italic">{emptyLabel}</p>
      ) : (
        <ul className="flex flex-col gap-2">
          {jobs.map((j) => (
            <li
              key={j.contract_id}
              className="rounded-lg border border-zinc-800 bg-zinc-950/40 p-3 flex flex-col gap-1.5"
            >
              <div className="flex items-baseline justify-between gap-2">
                <h3 className="font-semibold text-sm text-zinc-100 capitalize">
                  {j.category.replace(/_/g, " ")}
                </h3>
                <span className="font-mono text-xs text-emerald-300">
                  {formatCents(j.amount_cents, j.currency)}
                </span>
              </div>
              {j.scope && (
                <p className="text-xs text-zinc-300 leading-snug">
                  {j.scope.slice(0, 200)}
                  {j.scope.length > 200 ? "…" : ""}
                </p>
              )}
              <div className="flex gap-3 text-[11px] text-zinc-400 font-mono">
                {j.next_appointment_at && (
                  <span>
                    {t("nextAt", {
                      when: new Date(j.next_appointment_at).toLocaleString(),
                    })}
                  </span>
                )}
                {j.esign_envelope_status && (
                  <span>
                    {t("esignLabel")}: {j.esign_envelope_status}
                  </span>
                )}
              </div>
              {renderExtras ? renderExtras(j) : null}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
