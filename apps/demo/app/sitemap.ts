import type { MetadataRoute } from "next";
import { locales } from "../src/i18n/routing";

const SITE_URL = "https://www.isolveurproblems.ai";

// Public, indexable, non-parameterized routes only. Account/auth/checkout/
// contractor-dashboard/dispute/report pages are user-specific or gated —
// excluded here and disallowed in robots.ts.
const PUBLIC_PATHS = ["", "/legal", "/privacy", "/ai-guarantee", "/for-contractors", "/contractors"];

export default function sitemap(): MetadataRoute.Sitemap {
  const entries: MetadataRoute.Sitemap = [];

  for (const path of PUBLIC_PATHS) {
    for (const locale of locales) {
      const prefix = locale === "en" ? "" : `/${locale}`;
      entries.push({
        url: `${SITE_URL}${prefix}${path}`,
        lastModified: new Date("2026-07-08"),
        changeFrequency: path === "" ? "daily" : "monthly",
        priority: path === "" ? 1 : 0.6,
      });
    }
  }

  return entries;
}
