import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { NextIntlClientProvider } from "next-intl";
import { setRequestLocale, getMessages } from "next-intl/server";
import { routing } from "../../src/i18n/routing";
import { AssistantSurface } from "../../src/components/AssistantSurface";
import { SiteFooter } from "../../src/components/SiteFooter";

const SITE_URL = "https://www.isolveurproblems.ai";
const SITE_TITLE = "iSolveUrProblems.ai — Your Ai-Powered Solution Center";
const SITE_DESCRIPTION =
  "Talk to 6, get vetted contractor picks, and get your problem solved — from first question to a finished job.";

/**
 * Locale layout — wraps every page under /[locale]/ in NextIntlClientProvider.
 *
 * `setRequestLocale` enables static rendering of localized pages (Next.js
 * App Router won't pre-render server components that read translations
 * without this hint).
 */
export function generateStaticParams() {
  return routing.locales.map((locale) => ({ locale }));
}

export async function generateMetadata({
  params,
}: {
  params: Promise<{ locale: string }>;
}): Promise<Metadata> {
  const { locale } = await params;
  const prefix = locale === "en" ? "" : `/${locale}`;
  return {
    metadataBase: new URL(SITE_URL),
    title: SITE_TITLE,
    description: SITE_DESCRIPTION,
    alternates: { canonical: `${prefix}/` },
    openGraph: {
      title: SITE_TITLE,
      description: SITE_DESCRIPTION,
      url: `${prefix}/`,
      siteName: "iSolveUrProblems.ai",
      locale,
      type: "website",
    },
    twitter: {
      card: "summary",
      title: SITE_TITLE,
      description: SITE_DESCRIPTION,
    },
  };
}

export default async function LocaleLayout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  if (!(routing.locales as readonly string[]).includes(locale)) {
    notFound();
  }
  setRequestLocale(locale);

  const messages = await getMessages();

  return (
    <NextIntlClientProvider locale={locale} messages={messages}>
      {children}
      {/*
        M3.0b — Assistant Surface drawer. Mounted at the locale layout so it
        persists across navigation between sibling routes. Non-modal: the
        avatar UI stays interactive while the drawer is open.
      */}
      <AssistantSurface />
      <SiteFooter />
    </NextIntlClientProvider>
  );
}
