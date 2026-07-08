import { setRequestLocale } from "next-intl/server";
import { notFound } from "next/navigation";
import DevSurfaceClient from "./DevSurfaceClient";

export const dynamic = "force-dynamic";

/**
 * Dev-only sandbox for the M3.0b Assistant Surface. Each button pushes a
 * canned payload into the surface store so we can verify the drawer
 * renders each variant correctly before M3.0e ships.
 *
 * SERVER-side prod lock (Herm TASK_070): PRODUCTION deployments 404 before
 * the client demo can mount. VERCEL_ENV (not NODE_ENV) on purpose — preview
 * builds also compile with NODE_ENV=production, and G tunes these sandboxes
 * on previews mint-free. The client inner keeps a hostname belt-and-braces.
 */
export default async function DevSurfacePage({
  params,
}: {
  params: Promise<{ locale: string }>;
}) {
  if (process.env.VERCEL_ENV === "production") notFound();
  const { locale } = await params;
  setRequestLocale(locale);
  return <DevSurfaceClient />;
}
