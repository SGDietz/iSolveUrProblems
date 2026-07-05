export const API_KEY = process.env.LIVEAVATAR_API_KEY || "";
export const API_URL = process.env.LIVEAVATAR_API_URL || "";
export const AVATAR_ID = process.env.LIVEAVATAR_AVATAR_ID || "";

// FULL MODE Customizations
// Wayne's avatar voice and context
export const VOICE_ID = process.env.LIVEAVATAR_VOICE_ID || "";
export const CONTEXT_ID = process.env.LIVEAVATAR_CONTEXT_ID || "";
export const LANGUAGE = process.env.LIVEAVATAR_LANGUAGE || "";

// CUSTOM MODE Customizations
export const ELEVENLABS_API_KEY = process.env.ELEVENLABS_API_KEY || "";
export const OPENAI_API_KEY = process.env.OPENAI_API_KEY || "";
export const GEMINI_API_KEY = process.env.GEMINI_API_KEY || "";

// Supabase Auth (M1.1)
// SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY are read directly in supabaseAdmin.ts
// for server-side service-role use. The anon key + a NEXT_PUBLIC_ variant are
// required by @supabase/ssr for cookie-based user auth.
export const SUPABASE_URL = process.env.SUPABASE_URL || "";
export const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY || "";
// Public-readable copies (Next.js inlines NEXT_PUBLIC_* into the client bundle).
export const NEXT_PUBLIC_SUPABASE_URL =
  process.env.NEXT_PUBLIC_SUPABASE_URL || SUPABASE_URL;
export const NEXT_PUBLIC_SUPABASE_ANON_KEY =
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || SUPABASE_ANON_KEY;

// Notifications fabric (M1.7)
// Email — Resend (already used in leadAlert.ts; reusing the same key).
export const RESEND_API_KEY = process.env.RESEND_API_KEY || "";
export const RESEND_FROM_EMAIL =
  process.env.RESEND_FROM_EMAIL || "6 from iSolveUrProblems <onboarding@resend.dev>";
export const RESEND_WEBHOOK_SECRET = process.env.RESEND_WEBHOOK_SECRET || "";

// SMS + WhatsApp — Twilio.
export const TWILIO_ACCOUNT_SID = process.env.TWILIO_ACCOUNT_SID || "";
export const TWILIO_AUTH_TOKEN = process.env.TWILIO_AUTH_TOKEN || "";
export const TWILIO_FROM_PHONE = process.env.TWILIO_FROM_PHONE || "";
export const TWILIO_WHATSAPP_FROM = process.env.TWILIO_WHATSAPP_FROM || "";

// Feature flag — WhatsApp stays scaffolded but disabled until Meta BSP
// approval lands. Set FEATURE_WHATSAPP=1 to enable.
export const FEATURE_WHATSAPP = process.env.FEATURE_WHATSAPP === "1";

// Contractor data source (M2.1)
// Real contractors or nothing (G 2026-07-02). This defaults to unset in every
// environment so getContractorSource() fails closed unless a real provider such
// as 'outscraper'/'serpapi' is explicitly configured.
export const CONTRACTOR_DATA_SOURCE = process.env.CONTRACTOR_DATA_SOURCE || "";
export const SERPAPI_API_KEY = process.env.SERPAPI_API_KEY || "";
// Real live supply engine — Outscraper (Google Maps). Server-only key.
export const OUTSCRAPER_API_KEY = process.env.OUTSCRAPER_API_KEY || "";

// Admin operations (M2.1+) — privileged contractor/account override flows, etc.
// Required to call privileged /api/admin/* routes. Set via Vercel env.
export const ADMIN_SECRET = process.env.ADMIN_SECRET || "";

// Cron auth (M3.4+) — guards /api/cron/* routes against public traffic.
// On Vercel: set as a project env var and reference in vercel.json's
// crons block. Locally: pass via Authorization: Bearer header when
// triggering manually.
export const CRON_SECRET = process.env.CRON_SECRET || "";

// Payments — Stripe Connect Express (M2.5).
// Q2.5a: Connect flavor = Express.
// Q2.5b: charge at acceptance.
// Q2.5c: platform fee = 5% (PLATFORM_FEE_PERCENT overrides).
// Q2.5d: USD only (PLATFORM_CURRENCY overrides).
// All Stripe routes return 503 'payments not configured' until
// STRIPE_SECRET_KEY is present.
export const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY || "";
export const STRIPE_PUBLISHABLE_KEY = process.env.STRIPE_PUBLISHABLE_KEY || "";
export const NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY =
  process.env.NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY || STRIPE_PUBLISHABLE_KEY;
export const STRIPE_WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET || "";

// Connect Express onboarding return URLs — Stripe redirects the
// contractor here after their onboarding flow. Set to {app}/contractor/
// onboarding/return and /refresh once contractor-side pages exist.
export const STRIPE_CONNECT_RETURN_URL =
  process.env.STRIPE_CONNECT_RETURN_URL || "";
export const STRIPE_CONNECT_REFRESH_URL =
  process.env.STRIPE_CONNECT_REFRESH_URL || "";

// Platform take, as a percentage of the gross contract amount.
// G 2026-06-30: our margin 7% + Stripe processing 2.9% = 9.9% total, shown to
// the payer as a breakdown so the payment rails never eat into our margin.
const _PLATFORM_FEE_PERCENT_RAW = process.env.PLATFORM_FEE_PERCENT;
export const PLATFORM_FEE_PERCENT =
  _PLATFORM_FEE_PERCENT_RAW && !Number.isNaN(parseFloat(_PLATFORM_FEE_PERCENT_RAW))
    ? Math.max(0, Math.min(100, parseFloat(_PLATFORM_FEE_PERCENT_RAW)))
    : 7;

// Stripe card processing fee (2.9% + 30¢ per charge; we surface the % here).
const _STRIPE_FEE_PERCENT_RAW = process.env.STRIPE_FEE_PERCENT;
export const STRIPE_FEE_PERCENT =
  _STRIPE_FEE_PERCENT_RAW && !Number.isNaN(parseFloat(_STRIPE_FEE_PERCENT_RAW))
    ? Math.max(0, Math.min(100, parseFloat(_STRIPE_FEE_PERCENT_RAW)))
    : 2.9;

// What the payer sees as the total service fee (platform margin + processing).
export const TOTAL_FEE_PERCENT =
  Math.round((PLATFORM_FEE_PERCENT + STRIPE_FEE_PERCENT) * 100) / 100;

export const PLATFORM_CURRENCY = (
  process.env.PLATFORM_CURRENCY || "usd"
).toLowerCase();

// Where Stripe Checkout returns the homeowner after pay-success / cancel.
// Falls back to a relative path — Stripe will treat that as same-origin
// when the route is called server-side.
export const STRIPE_CHECKOUT_RETURN_PATH =
  process.env.STRIPE_CHECKOUT_RETURN_PATH || "/checkout";

// Dispute mediator — admin escalation queue (Q3.9a). When a dispute
// trips the 3-strike rule, exceeds $500 disputed, or the user asks for
// a human, the mediator hands off here. Either channel (Slack incoming
// webhook OR a designated email) is enough — both is fine. If neither
// is set we log a warning and the escalation persists in DB only.
export const ADMIN_ESCALATION_SLACK_WEBHOOK_URL =
  process.env.ADMIN_ESCALATION_SLACK_WEBHOOK_URL || "";
export const ADMIN_ESCALATION_EMAIL =
  process.env.ADMIN_ESCALATION_EMAIL || "";

// M3.1 — Twilio Programmable Voice (3-way phone calls).
// Reuses TWILIO_ACCOUNT_SID / TWILIO_AUTH_TOKEN. The Voice
// number is separate from TWILIO_FROM_PHONE (SMS); both can be the
// same or different E.164 numbers depending on Twilio plan.
export const TWILIO_VOICE_FROM_NUMBER =
  process.env.TWILIO_VOICE_FROM_NUMBER || "";

// M3.1 — public app origin used to build absolute URLs for Twilio
// webhooks (TwiML, status, transcription, recording). Twilio requires
// publicly reachable HTTPS; in dev use ngrok / cloudflared tunnels.
export const APP_PUBLIC_BASE_URL =
  process.env.APP_PUBLIC_BASE_URL || "";

// M3.3 — Supabase Storage bucket for call recordings. Created via
// migration; private by default. Recordings reach Supabase via the
// recording-completed webhook fetching from the Twilio media URL.
export const CALL_RECORDINGS_BUCKET =
  process.env.CALL_RECORDINGS_BUCKET || "call-recordings";

// M3.7 — Dropbox Sign (production e-signature provider).
// Set ESIGN_PROVIDER=dropbox_sign in env to flip the registry switch.
// Mock provider stays the default while these are absent.
export const ESIGN_PROVIDER = (process.env.ESIGN_PROVIDER || "mock").toLowerCase();
export const DROPBOX_SIGN_API_KEY = process.env.DROPBOX_SIGN_API_KEY || "";
export const DROPBOX_SIGN_CLIENT_ID = process.env.DROPBOX_SIGN_CLIENT_ID || "";
export const DROPBOX_SIGN_WEBHOOK_SECRET =
  process.env.DROPBOX_SIGN_WEBHOOK_SECRET || "";

// M4.1 — Stripe Billing (contractor subscriptions). Different product
// from Stripe Connect (M2.5 contractor payouts); same Stripe account +
// same STRIPE_SECRET_KEY but separate webhook secret + separate Price
// IDs per tier. Create the products in the Stripe dashboard, then drop
// the IDs here. Q4.1a tier pricing is directional — Bert sets the
// final numbers before launch.
//
// Tier mapping:
//   - free   → no Price ID; default tier when no active subscription
//   - bronze → STRIPE_PRICE_BRONZE
//   - silver → STRIPE_PRICE_SILVER
//   - gold   → STRIPE_PRICE_GOLD
export const STRIPE_PRICE_BRONZE = process.env.STRIPE_PRICE_BRONZE || "";
export const STRIPE_PRICE_SILVER = process.env.STRIPE_PRICE_SILVER || "";
export const STRIPE_PRICE_GOLD = process.env.STRIPE_PRICE_GOLD || "";
export const STRIPE_BILLING_WEBHOOK_SECRET =
  process.env.STRIPE_BILLING_WEBHOOK_SECRET || "";

// Trial length for new subscriptions (days). 14d default per Risks
// section of M4 build order ("v1 should include a free trial").
const _TRIAL_DAYS_RAW = process.env.STRIPE_TRIAL_DAYS;
export const STRIPE_TRIAL_DAYS = (() => {
  if (!_TRIAL_DAYS_RAW) return 14;
  const n = parseInt(_TRIAL_DAYS_RAW, 10);
  return Number.isFinite(n) && n >= 0 && n <= 90 ? n : 14;
})();
