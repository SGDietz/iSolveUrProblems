import { createServerClient, type CookieOptions } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";
import createIntlMiddleware from "next-intl/middleware";
import { routing } from "./src/i18n/routing";

/**
 * Composed middleware: next-intl locale routing first (rewrites /es/...
 * paths or redirects when needed), then Supabase auth-cookie refresh on
 * top of the result.
 *
 * The intl middleware is skipped for:
 *  - /api/*               (route handlers stay unlocalized)
 *  - /auth/callback        (OAuth redirect target is a fixed URL)
 *  - /_next, /favicon, etc (already excluded by matcher)
 */
const intlMiddleware = createIntlMiddleware(routing);

function shouldSkipIntl(pathname: string): boolean {
  return (
    pathname.startsWith("/api/") ||
    pathname === "/auth/callback" ||
    pathname.startsWith("/auth/callback/")
  );
}

export async function middleware(request: NextRequest) {
  // 1. Run intl middleware unless this path opts out (API, OAuth callback).
  const response = shouldSkipIntl(request.nextUrl.pathname)
    ? NextResponse.next({ request: { headers: request.headers } })
    : intlMiddleware(request);

  // 2. Layer Supabase auth-cookie refresh on top of whatever intl produced.
  const url =
    process.env.SUPABASE_URL ?? process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anonKey =
    process.env.SUPABASE_ANON_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !anonKey) return response;

  const supabase = createServerClient(url, anonKey, {
    cookies: {
      getAll() {
        return request.cookies.getAll();
      },
      setAll(
        cookiesToSet: {
          name: string;
          value: string;
          options: CookieOptions;
        }[],
      ) {
        for (const { name, value, options } of cookiesToSet) {
          response.cookies.set(name, value, options);
        }
      },
    },
  });

  // Touching getUser() refreshes the session if needed.
  await supabase.auth.getUser();
  return response;
}

export const config = {
  matcher: [
    // Run on all paths except Next.js internals, static assets, webhooks,
    // and the metadata-route conventions (robots.txt, sitemap.xml,
    // .well-known/*) — those aren't locale-prefixed pages, and letting
    // next-intl's middleware touch them 404s the route (2026-07-08 fix).
    "/((?!_next/static|_next/image|favicon.ico|robots.txt|sitemap.xml|\\.well-known|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico)$|api/webhooks/).*)",
  ],
};
