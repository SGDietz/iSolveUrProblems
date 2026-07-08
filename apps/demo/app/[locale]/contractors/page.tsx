import { setRequestLocale, getTranslations } from "next-intl/server";
import { notFound } from "next/navigation";
import { Link } from "../../../src/i18n/routing";
import SearchClient from "./SearchClient";

export const dynamic = "force-dynamic";

const CATEGORY_SLUGS = [
  "plumber",
  "electrician",
  "hvac",
  "roofer",
  "landscaper",
  "painter",
  "handyman",
  "general",
  "carpenter",
  "flooring",
  "appliance",
  "cleaning",
  "pest",
  "garage_door",
  "window",
] as const;

export default async function ContractorsPage({
  params,
  searchParams,
}: {
  params: Promise<{ locale: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  // Engineering-debug surface only (see banner below) — 6 drives contractor
  // search by voice on the home page. Its bare tel:/pick/hire controls bypass
  // the call-consent doctrine, so PRODUCTION 404s server-side before mount
  // (Herm TASK_090). VERCEL_ENV, not NODE_ENV, on purpose: preview builds
  // also compile with NODE_ENV=production and this stays usable there.
  if (process.env.VERCEL_ENV === "production") notFound();
  const { locale } = await params;
  setRequestLocale(locale);
  const t = await getTranslations("contractors");
  const sp = await searchParams;
  const initialCategory =
    typeof sp.category === "string" &&
    (CATEGORY_SLUGS as readonly string[]).includes(sp.category)
      ? sp.category
      : null;

  return (
    <main className="w-full max-w-4xl flex flex-col gap-6 px-6 py-12">
      <header className="flex flex-col gap-2">
        <p className="text-[11px] uppercase tracking-[0.2em] text-zinc-500">
          {t("kicker")}
        </p>
        <h1 className="text-2xl font-semibold">{t("title")}</h1>
        <p className="text-sm text-zinc-400">{t("blurb")}</p>
      </header>

      {/*
        M3.0d — this form-driven surface is no longer the primary UX.
        6 drives this by voice now; this page persists as a debug surface
        for engineering. Banner reminds anyone who lands here.
      */}
      <div className="rounded-md border border-amber-400/40 bg-amber-400/5 px-4 py-2 text-xs text-amber-200">
        Dev surface — 6 now drives contractor search by voice on the home page (M3.0d). Form-driven page kept for engineering debug.
      </div>

      <SearchClient
        categories={[...CATEGORY_SLUGS]}
        initialCategory={initialCategory}
      />

      <div className="mt-6">
        <Link
          href="/"
          className="rounded-md bg-zinc-800 px-4 py-2 text-sm text-zinc-200 hover:bg-zinc-700"
        >
          {t("backTo6")}
        </Link>
      </div>
    </main>
  );
}
