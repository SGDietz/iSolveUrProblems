import { setRequestLocale } from "next-intl/server";
import { notFound } from "next/navigation";
import CardsDemoClient from "./CardsDemoClient";

export const dynamic = "force-dynamic";

/**
 * Dev-only sandbox for the contractor card whoosh. Hardcoded sample cards are
 * never production-visible; PRODUCTION deployments 404 from the server before
 * the client demo can mount. VERCEL_ENV (not NODE_ENV) on purpose — preview
 * builds also compile with NODE_ENV=production, and G tunes the whoosh here
 * on previews mint-free. The client inner keeps a hostname belt-and-braces.
 */
export default async function CardsDemoPage({
  params,
}: {
  params: Promise<{ locale: string }>;
}) {
  if (process.env.VERCEL_ENV === "production") notFound();
  const { locale } = await params;
  setRequestLocale(locale);
  return <CardsDemoClient />;
}
