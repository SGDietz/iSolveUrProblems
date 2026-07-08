import { setRequestLocale, getTranslations } from "next-intl/server";
import { Link } from "../../../src/i18n/routing";
import { getUserId } from "../../../src/lib/auth/getUser";
import { getSupabaseAdminConfig } from "../../../src/lib/supabaseAdmin";
import ClaimForm from "./ClaimForm";

export const dynamic = "force-dynamic";

/**
 * M4.0c — /for-contractors landing page.
 *
 * Three states:
 *   1. Anonymous → call-to-action with "Sign in / Sign up" → magic-link
 *   2. Authenticated, no contractor profile → CTA to claim or create
 *   3. Authenticated, already a contractor → redirect-style link to
 *      /contractor/dashboard
 *
 * This is intentionally a server component reading the auth state +
 * the user's role. The claim form itself is a client component.
 */

type UserRoleInfo = {
  role: "homeowner" | "contractor" | "admin";
  contractor_id: string | null;
};

async function fetchUserRole(userId: string): Promise<UserRoleInfo | null> {
  try {
    const { url, serviceRoleKey } = getSupabaseAdminConfig();
    const res = await fetch(
      `${url}/rest/v1/users?id=eq.${encodeURIComponent(userId)}&select=role,contractor_id&limit=1`,
      {
        headers: {
          apikey: serviceRoleKey,
          Authorization: `Bearer ${serviceRoleKey}`,
        },
        cache: "no-store",
      },
    );
    if (!res.ok) return null;
    const rows = (await res.json()) as UserRoleInfo[];
    return rows[0] ?? null;
  } catch {
    return null;
  }
}

export default async function ForContractorsPage({
  params,
}: {
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  setRequestLocale(locale);
  const t = await getTranslations("forContractors");
  const userId = await getUserId();

  // Anonymous → sign-in CTA
  if (!userId) {
    return (
      <main className="w-full max-w-2xl flex flex-col gap-8 px-6 py-12">
        <header className="flex flex-col gap-3">
          <p className="text-[11px] uppercase tracking-[0.2em] text-amber-300">
            {t("kicker")}
          </p>
          <h1 className="text-3xl font-semibold text-zinc-100">{t("hero.title")}</h1>
          <p className="text-zinc-300 text-base leading-relaxed">{t("hero.blurb")}</p>
        </header>

        <ul className="flex flex-col gap-3 text-sm text-zinc-200">
          <li className="flex gap-2"><span className="text-amber-300">·</span>{t("benefit.leads")}</li>
          <li className="flex gap-2"><span className="text-amber-300">·</span>{t("benefit.contracts")}</li>
          <li className="flex gap-2"><span className="text-amber-300">·</span>{t("benefit.payouts")}</li>
          <li className="flex gap-2"><span className="text-amber-300">·</span>{t("benefit.recurring")}</li>
          <li className="flex gap-2"><span className="text-amber-300">·</span>{t("benefit.crew")}</li>
        </ul>

        <div className="flex flex-col gap-3">
          <Link
            href={{
              pathname: "/auth/sign-in",
              query: { next: "/for-contractors" },
            }}
            locale={locale as "en"}
            className="rounded-md bg-emerald-500/90 hover:bg-emerald-500 text-zinc-950 text-sm font-semibold px-4 py-2.5 text-center"
          >
            {t("cta.signIn")}
          </Link>
          <p className="text-xs text-zinc-500 text-center">{t("cta.signInBlurb")}</p>
        </div>
      </main>
    );
  }

  const roleInfo = await fetchUserRole(userId);

  // Already a contractor → dashboard link
  if (roleInfo?.role === "contractor" && roleInfo.contractor_id) {
    return (
      <main className="w-full max-w-2xl flex flex-col gap-6 px-6 py-12">
        <p className="text-[11px] uppercase tracking-[0.2em] text-amber-300">
          {t("kicker")}
        </p>
        <h1 className="text-2xl font-semibold text-zinc-100">
          {t("already.title")}
        </h1>
        <p className="text-zinc-300">{t("already.blurb")}</p>
        <Link
          href="/contractor/dashboard"
          className="rounded-md bg-emerald-500/90 hover:bg-emerald-500 text-zinc-950 text-sm font-semibold px-4 py-2.5 text-center"
        >
          {t("already.goCta")}
        </Link>
      </main>
    );
  }

  // Signed in but not yet a contractor → claim flow
  return (
    <main className="w-full max-w-2xl flex flex-col gap-6 px-6 py-12">
      <header className="flex flex-col gap-3">
        <p className="text-[11px] uppercase tracking-[0.2em] text-amber-300">
          {t("kicker")}
        </p>
        <h1 className="text-2xl font-semibold text-zinc-100">{t("claim.title")}</h1>
        <p className="text-zinc-300">{t("claim.blurb")}</p>
      </header>

      <ClaimForm />

      <p className="text-xs text-zinc-500">
        {t("claim.privacyFootnote")}
      </p>
    </main>
  );
}
