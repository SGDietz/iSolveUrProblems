import { NextRequest, NextResponse } from "next/server";

// DEV-ONLY diagnostic breadcrumb sink for the voice-account smoke.
//
// We cannot open the app in a dev browser to read its console (loading the page
// mints the avatar = real money), so the client account fast-path POSTs its
// breadcrumbs here and they print to the dev server console — readable from the
// dev log with no browser. Inert (404) in production so it never ships live.
export async function POST(req: NextRequest) {
  if (process.env.NODE_ENV === "production") {
    return NextResponse.json({ ok: false }, { status: 404 });
  }
  try {
    const body = await req.json();
    // Single tagged line so it's easy to grep in the dev log.
    console.log("[account-diag]", JSON.stringify(body));
  } catch {
    console.log("[account-diag] (unparseable body)");
  }
  return NextResponse.json({ ok: true });
}
