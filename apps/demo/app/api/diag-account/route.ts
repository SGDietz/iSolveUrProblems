import { NextRequest, NextResponse } from "next/server";
import { checkRateLimit } from "../../../src/lib/rateLimit";

// Diagnostic breadcrumb sink for the voice-account smoke.
//
// We cannot open the app in a browser to read its console (loading the page mints
// the avatar = real money), so the client POSTs breadcrumbs here and they print to
// the server console — readable from the dev log (localhost) or the Vercel function
// logs (preview). Gated on VERCEL_ENV, NOT NODE_ENV: Vercel preview runs as
// NODE_ENV=production, so the old NODE_ENV gate 404'd on every preview smoke and we
// got no breadcrumbs. VERCEL_ENV is "preview" on preview deploys and "production"
// only on the real domain — so this logs on dev + preview, stays inert on prod.
export async function POST(req: NextRequest) {
  if (process.env.VERCEL_ENV === "production") {
    return NextResponse.json({ ok: false }, { status: 404 });
  }
  // Preview/dev only past this point — rate-limit so a runaway client can't
  // flood the function logs (Herm release blocker #7).
  const rateLimitErr = await checkRateLimit(req);
  if (rateLimitErr) return rateLimitErr;
  try {
    const body = await req.json();
    // Single tagged line so it's easy to grep in the dev log.
    console.log("[account-diag]", JSON.stringify(body));
  } catch {
    console.log("[account-diag] (unparseable body)");
  }
  return NextResponse.json({ ok: true });
}
