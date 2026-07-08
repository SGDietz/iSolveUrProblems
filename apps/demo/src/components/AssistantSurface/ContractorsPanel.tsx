"use client";

import { useEffect, useMemo, useState, type CSSProperties } from "react";
import { useTranslations } from "next-intl";
import type { ContractorCard } from "../../lib/assistantSurface";
import { playWhoosh } from "../../lib/ui/sfx";
import { pingAppEvent } from "../../lib/observability/clientEvents";

// LiveAvatarSession listens for this and has 6 SPEAK the honest heads-up
// (once per mount) when the consent sheet opens — Herm TASK_088 layer 2.
const CALL_CONSENT_HEADS_UP_EVENT = "isolve:call-consent-heads-up";

function priceTierGlyph(tier: number | null): string {
  if (!tier || tier < 1) return "—";
  return "$".repeat(Math.min(4, Math.max(1, tier)));
}

// RANDOM whoosh chaos (G via Herm 2026-07-01: cards must come from ANY
// direction, never the same right/left/bottom cycle). 8 compass entries;
// each card rolls a direction + tilt + delay jitter per RUN (new search =
// new chaos, stable within a render). card-whoosh-var in globals.css reads
// the CSS variables.
const DIRECTIONS: Array<{ wx: string; wy: string }> = [
  { wx: "78vw", wy: "0vh" }, // right
  { wx: "-78vw", wy: "0vh" }, // left
  { wx: "0vw", wy: "85vh" }, // bottom
  { wx: "0vw", wy: "-85vh" }, // top
  { wx: "60vw", wy: "65vh" }, // bottom-right
  { wx: "-60vw", wy: "65vh" }, // bottom-left
  { wx: "60vw", wy: "-65vh" }, // top-right
  { wx: "-60vw", wy: "-65vh" }, // top-left
];

type CardMotion = { wx: string; wy: string; wrot: string; delayMs: number };

type ContractorEmailOutcome =
  | { ok: true; message: string }
  | { ok: false; message: string };

function rollMotions(count: number): CardMotion[] {
  let lastDir = -1;
  return Array.from({ length: count }, (_, i) => {
    // Re-roll once if we'd repeat the previous card's direction — chaos
    // reads better when consecutive cards visibly differ.
    let d = Math.floor(Math.random() * DIRECTIONS.length);
    if (d === lastDir) d = (d + 1 + Math.floor(Math.random() * 6)) % DIRECTIONS.length;
    lastDir = d;
    const dir = DIRECTIONS[d];
    const rot = (Math.random() * 16 - 8).toFixed(1);
    const jitter = Math.floor(Math.random() * 140);
    return {
      wx: dir.wx,
      wy: dir.wy,
      wrot: `${rot}deg`,
      delayMs: i * 210 + jitter,
    };
  });
}

// "Go to website" opens their real listing in a new tab — their site if we
// have it, otherwise a Google Maps lookup by name. 6's tab stays alive behind.
function checkThemOutUrl(hit: { website: string | null; name: string }): string {
  if (hit.website) return hit.website;
  return `https://www.google.com/maps/search/${encodeURIComponent(hit.name)}`;
}

export function ContractorsPanel({
  hits,
  totalConsidered,
  compact = false,
}: {
  hits: ContractorCard[];
  totalConsidered: number;
  compact?: boolean;
}) {
  const t = useTranslations("assistant.surface.contractors");

  // Tap-to-call CONSENT GATE (G voice order 2026-07-02): tel: never fires
  // straight off a card tap. The sheet says the call goes out from the
  // USER'S phone (they are the caller — express YES is the dial), shows 6's
  // honest heads-up (6 can't join calls yet; Herm TASK_086 ruling: never
  // promise a 3-way) and the voicemail rule (the human leaves the message).
  const [pendingCall, setPendingCall] = useState<ContractorCard | null>(null);
  const [pendingEmail, setPendingEmail] = useState<ContractorCard | null>(null);
  const [emailMessage, setEmailMessage] = useState("");
  const [emailBusy, setEmailBusy] = useState(false);
  const [emailOutcome, setEmailOutcome] =
    useState<ContractorEmailOutcome | null>(null);

  // Every call intent and website tap is COUNTED in app_events (G order
  // 2026-07-02: "if people get the number and just call themselves, we're
  // out of the loop") — fire-and-forget, never blocks the tap.
  const openWebsite = (hit: ContractorCard) => {
    pingAppEvent("contractor_website_tap", {
      contractorId: hit.id,
      context: { name: hit.name },
    });
    window.open(checkThemOutUrl(hit), "_blank", "noopener,noreferrer");
  };

  const openConsent = (hit: ContractorCard) => {
    pingAppEvent("call_consent_open", {
      contractorId: hit.id,
      context: { name: hit.name },
    });
    setPendingCall(hit);
    if (typeof window !== "undefined") {
      window.dispatchEvent(
        new CustomEvent(CALL_CONSENT_HEADS_UP_EVENT, {
          detail: { text: t("callConsent.sixSays") },
        }),
      );
    }
  };

  const dismissConsent = () => {
    if (pendingCall) {
      pingAppEvent("call_consent_dismiss", { contractorId: pendingCall.id });
    }
    setPendingCall(null);
  };

  const openEmailConsent = (hit: ContractorCard) => {
    pingAppEvent("contractor_email_consent_open", {
      contractorId: hit.id,
      context: { name: hit.name },
    });
    setEmailMessage("");
    setEmailOutcome(null);
    setPendingEmail(hit);
  };

  const dismissEmailConsent = () => {
    if (pendingEmail) {
      pingAppEvent("contractor_email_consent_dismiss", {
        contractorId: pendingEmail.id,
      });
    }
    setPendingEmail(null);
    setEmailBusy(false);
    setEmailOutcome(null);
  };

  const confirmEmailIntro = async () => {
    if (!pendingEmail || emailBusy) return;
    setEmailBusy(true);
    setEmailOutcome(null);
    try {
      const res = await fetch(
        `/api/contractors/${encodeURIComponent(pendingEmail.id)}/email-intent`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ message: emailMessage }),
        },
      );
      const data = (await res.json().catch(() => ({}))) as {
        ok?: boolean;
        error?: string;
      };
      if (!res.ok || !data.ok) {
        setEmailOutcome({
          ok: false,
          message:
            data.error ??
            (res.status === 401
              ? t("emailConsent.signInRequired")
              : t("emailConsent.failed")),
        });
        return;
      }
      pingAppEvent("contractor_email_consent_yes", {
        contractorId: pendingEmail.id,
        context: { name: pendingEmail.name },
      });
      setEmailOutcome({ ok: true, message: t("emailConsent.sent") });
    } catch (e) {
      setEmailOutcome({
        ok: false,
        message: e instanceof Error ? e.message : t("emailConsent.failed"),
      });
    } finally {
      setEmailBusy(false);
    }
  };

  // One chaos roll per result set — stable across re-renders of the same
  // hits, fresh directions on every new search.
  const motions = useMemo(() => rollMotions(hits.length), [hits]);

  // One whoosh burst per card, timed to its entry (gain-capped in sfx.ts).
  // Autoplay-locked audio fails soft to silence.
  useEffect(() => {
    if (hits.length === 0) return;
    if (
      typeof window !== "undefined" &&
      window.matchMedia?.("(prefers-reduced-motion: reduce)").matches
    ) {
      return;
    }
    const timers = motions
      .slice(0, 5)
      .map((m) => window.setTimeout(() => playWhoosh("in"), m.delayMs));
    return () => timers.forEach((id) => window.clearTimeout(id));
  }, [hits, motions]);

  if (hits.length === 0) {
    return <p className="brand-grad-text text-sm">{t("empty")}</p>;
  }

  const rootGap = compact ? "gap-2" : "gap-3";
  const listGap = compact ? "gap-2" : "gap-3";
  const cardGap = compact ? "gap-0.5" : "gap-1";
  const cardPad = compact ? "px-3 py-2" : "px-4 py-3";
  const nameSize = compact ? "text-[0.9rem]" : "text-[1.02rem]";
  const metaSize = compact ? "text-[10px]" : "text-[11px]";
  const starSize = compact ? "text-xs" : "text-sm";
  const badgeSize = compact ? "text-[9px]" : "text-[10px]";
  const ctaPadding = compact ? "py-1.5" : "py-2";
  const ctaSize = compact ? "text-[11px]" : "text-xs";

  return (
    <div className={`flex flex-col ${rootGap}`}>
      <p className={`brand-grad-text ${compact ? "text-[10px]" : "text-xs"} font-semibold`}>
        {t("count", { shown: hits.length, considered: totalConsidered })}
      </p>
      <ul className={`flex flex-col ${listGap}`}>
        {hits.map((hit, i) => (
          <li
            key={hit.id}
            // WHOLE CARD = the website link (G screenshot order 2026-07-02
            // evening: "the whole thing could be a link except... the phone
            // number"). The number stopPropagations into the consent sheet.
            role="link"
            tabIndex={0}
            aria-label={`${hit.name} website`}
            onClick={() => openWebsite(hit)}
            onKeyDown={(e) => {
              if (e.key !== "Enter") return;
              // Only when the card itself has focus — a bubbled Enter from a
              // child control (phone button today, email later) must not also
              // open the website (Herm TASK_089).
              if (e.target !== e.currentTarget) return;
              openWebsite(hit);
            }}
            className={`flex cursor-pointer flex-col ${cardGap} rounded-2xl border-2 border-[#e0aa62]/85 bg-gradient-to-b from-[#341d07]/95 to-[#130a03]/95 ${cardPad} shadow-[inset_0_1px_10px_rgba(255,255,255,0.10),0_10px_28px_rgba(0,0,0,0.5)] backdrop-blur-[3px]`}
            style={
              {
                animation: `card-whoosh-var 0.62s cubic-bezier(0.16,1,0.3,1) both`,
                animationDelay: `${motions[i]?.delayMs ?? i * 210}ms`,
                willChange: "transform, opacity, filter",
                "--wx": motions[i]?.wx ?? "72vw",
                "--wy": motions[i]?.wy ?? "0vh",
                "--wrot": motions[i]?.wrot ?? "7deg",
              } as CSSProperties
            }
          >
            {/* Line 1 — name · review count (small) · star hugging the right
                (G screenshot order 2026-07-02 evening: "a lot of open space"
                — two dense lines instead of four). */}
            <div className="flex flex-wrap items-baseline gap-x-2">
              {/* Name IS the website link (whole card is clickable) — underline
                  it so the link reads (G screenshot 2026-07-06: "Hardy Plumbing
                  should have a line under it, it should be the website itself"). */}
              <h3 className={`brand-grad-text ${nameSize} font-black leading-tight underline decoration-[#e0aa62]/60 underline-offset-2`}>
                {hit.name}
              </h3>
              {/* Reviews hug the star on the right (G screenshot 2026-07-06 red
                  arrow: "63 reviews should be near the star, all three"). */}
              <span className="ml-auto flex shrink-0 items-baseline gap-x-1.5">
                {hit.rating_count != null && (
                  <span className={`${metaSize} text-[#e8b96a]/75`}>
                    {hit.rating_count.toLocaleString()} reviews
                  </span>
                )}
                <span className={`${starSize} font-bold text-[#ffd98a]`}>
                  {hit.rating_avg != null ? `★ ${hit.rating_avg.toFixed(1)}` : "★ —"}
                </span>
              </span>
            </div>
            {/* Line 2 — area left (the nearby-fill honesty anchor, Herm
                TASK_086) + phone right, "towards the star". The number is
                the ONLY tap that doesn't go to the website: it opens the
                call-consent sheet. */}
            {/* Area line — the honest city/state/ZIP. Phone REMOVED from here
                (G screenshot 2026-07-06: "you've got the phone number at two
                different places"); it now lives ONLY in the Call pillbox. */}
            {hit.area_label && (
              <div className="flex flex-wrap items-center gap-x-2">
                <span className={`${metaSize} font-semibold text-[#f1c477]/80`}>
                  {hit.area_label}
                </span>
              </div>
            )}
            {(hit.distance_km > 0 ||
              hit.price_tier != null ||
              hit.licensed_flag ||
              hit.same_day_flag ||
              hit.locally_owned) && (
              <div className={`mt-0.5 flex flex-wrap items-center gap-1.5 ${badgeSize}`}>
                {hit.distance_km > 0 && (
                  <span className="font-mono text-[#e8b96a]/70">
                    {hit.distance_km.toFixed(1)} km
                  </span>
                )}
                {hit.price_tier != null && (
                  <span className="font-mono text-[#e8b96a]/70">
                    {priceTierGlyph(hit.price_tier)}
                  </span>
                )}
                {hit.licensed_flag && (
                  <span className="rounded-full border border-[#e0aa62]/40 px-2 py-0.5 uppercase tracking-wide text-[#e8b96a]">
                    {t("badge.licensed")}
                  </span>
                )}
                {hit.same_day_flag && (
                  <span className="rounded-full border border-[#e0aa62]/40 px-2 py-0.5 uppercase tracking-wide text-[#e8b96a]">
                    {t("badge.sameDay")}
                  </span>
                )}
                {hit.locally_owned && (
                  <span className="rounded-full border border-[#e0aa62]/40 px-2 py-0.5 uppercase tracking-wide text-[#e8b96a]">
                    {t("badge.locallyOwned")}
                  </span>
                )}
              </div>
            )}
            {/* Domain line REMOVED (G screenshot 2026-07-06: X'd out the
                "callhardyplumbing.com" — "no website down there; Hardy Plumbing
                should BE the link, without the website name"). The underlined
                company name up top is the website link now. */}
            {/* Line-only email REMOVED (Herm TASK_098 polish: it duplicated
                the Email pill below and crowded the card). The CTA pill is
                the one email affordance now. */}
            {/* CTA pillboxes RETURN (G voice orders smoke #6 addendum 2 +
                #7: "the pillboxes should say Call 410-... or email — to do
                either one"). Call → the consent sheet, NEVER a bare dial;
                Email only when a real address exists. stopPropagation so
                the whole-card website link doesn't also fire. */}
            {(hit.phone || (hit.email && /@/.test(hit.email))) && (
              <div
                className={`mt-2 grid gap-2 ${
                  hit.phone && hit.email && /@/.test(hit.email)
                    ? "grid-cols-2"
                    : "grid-cols-1"
                }`}
              >
                {hit.phone && (
                  <button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation();
                      openConsent(hit);
                    }}
                    className={`flex items-center justify-center rounded-full bg-gradient-to-b from-[#ffe9c2] via-[#d7a05a] to-[#9e6a35] ${ctaPadding} ${ctaSize} font-black tracking-wide text-[#2a1606] shadow-[inset_0_1px_0_rgba(255,255,255,0.5),0_6px_16px_rgba(0,0,0,0.45)] active:brightness-90`}
                  >
                    {t("cta.call", { phone: hit.phone })}
                  </button>
                )}
                {hit.email && /@/.test(hit.email) && (
                  <button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation();
                      openEmailConsent(hit);
                    }}
                    className={`flex items-center justify-center rounded-full border-2 border-[#e0aa62]/70 bg-gradient-to-b from-[#341d07] to-[#130a03] ${ctaPadding} ${ctaSize} font-black tracking-wide text-[#f1c477] shadow-[inset_0_1px_6px_rgba(255,255,255,0.08),0_6px_16px_rgba(0,0,0,0.45)] active:brightness-90`}
                  >
                    {t("cta.email")}
                  </button>
                )}
              </div>
            )}
          </li>
        ))}
      </ul>
      {pendingCall?.phone && (
        <div
          className="fixed inset-0 z-[999] flex items-end justify-center bg-black/60 p-4 backdrop-blur-[2px] sm:items-center"
          onClick={dismissConsent}
        >
          <div
            role="dialog"
            aria-modal="true"
            className="w-full max-w-sm rounded-2xl border-2 border-[#e0aa62]/85 bg-gradient-to-b from-[#341d07] to-[#130a03] px-4 py-4 shadow-[inset_0_1px_10px_rgba(255,255,255,0.10),0_14px_40px_rgba(0,0,0,0.6)]"
            onClick={(e) => e.stopPropagation()}
          >
            <h3 className="brand-grad-text text-lg font-black leading-tight">
              {t("callConsent.title", { name: pendingCall.name })}
            </h3>
            <p className="mt-1 text-xs font-semibold text-[#f1c477]/90">
              {t("callConsent.body")}
            </p>
            <p className="mt-2 rounded-xl border border-[#e0aa62]/40 bg-black/25 px-3 py-2 text-xs leading-relaxed text-[#ffe9c2]/90">
              {t("callConsent.sixSays")}
            </p>
            <div className="mt-3 grid grid-cols-2 gap-2">
              <button
                type="button"
                onClick={dismissConsent}
                className="btn-inset flex items-center justify-center rounded-full py-2 text-xs font-bold tracking-wide active:brightness-90"
              >
                {t("callConsent.cancel")}
              </button>
              {/* The dial is THIS tap and nothing else — a real tel: anchor,
                  so the express YES itself places the call from the user's
                  own phone. */}
              <a
                href={`tel:${pendingCall.phone}`}
                onClick={() => {
                  pingAppEvent("call_consent_yes", {
                    contractorId: pendingCall.id,
                    context: { name: pendingCall.name },
                  });
                  setPendingCall(null);
                }}
                className="flex items-center justify-center rounded-full bg-gradient-to-b from-[#ffe9c2] via-[#d7a05a] to-[#9e6a35] py-2 text-xs font-black tracking-wide text-[#2a1606] shadow-[inset_0_1px_0_rgba(255,255,255,0.5),0_6px_16px_rgba(0,0,0,0.45)] active:brightness-90"
              >
                {t("callConsent.confirm")}
              </a>
            </div>
          </div>
        </div>
      )}
      {pendingEmail?.email && (
        <div
          className="fixed inset-0 z-[999] flex items-end justify-center bg-black/60 p-4 backdrop-blur-[2px] sm:items-center"
          onClick={dismissEmailConsent}
        >
          <div
            role="dialog"
            aria-modal="true"
            className="w-full max-w-sm rounded-2xl border-2 border-[#e0aa62]/85 bg-gradient-to-b from-[#341d07] to-[#130a03] px-4 py-4 shadow-[inset_0_1px_10px_rgba(255,255,255,0.10),0_14px_40px_rgba(0,0,0,0.6)]"
            onClick={(e) => e.stopPropagation()}
          >
            <h3 className="brand-grad-text text-lg font-black leading-tight">
              {t("emailConsent.title", { name: pendingEmail.name })}
            </h3>
            <p className="mt-1 text-xs font-semibold text-[#f1c477]/90">
              {t("emailConsent.body")}
            </p>
            <p className="mt-2 rounded-xl border border-[#e0aa62]/40 bg-black/25 px-3 py-2 text-xs leading-relaxed text-[#ffe9c2]/90">
              {t("emailConsent.disclosure")}
            </p>
            <label className="mt-3 flex flex-col gap-1 text-xs font-semibold text-[#f1c477]/90">
              {t("emailConsent.messageLabel")}
              <textarea
                value={emailMessage}
                onChange={(e) => setEmailMessage(e.target.value.slice(0, 500))}
                placeholder={t("emailConsent.placeholder")}
                rows={3}
                className="resize-none rounded-xl border border-[#e0aa62]/45 bg-black/25 px-3 py-2 text-xs font-medium text-[#ffe9c2] outline-none placeholder:text-[#e8b96a]/45 focus:border-[#ffd98a]"
              />
            </label>
            {emailOutcome && (
              <p
                className={`mt-2 rounded-xl border px-3 py-2 text-xs font-semibold ${
                  emailOutcome.ok
                    ? "border-emerald-300/40 bg-emerald-500/10 text-emerald-100"
                    : "border-red-300/40 bg-red-500/10 text-red-100"
                }`}
              >
                {emailOutcome.message}
              </p>
            )}
            <div className="mt-3 grid grid-cols-2 gap-2">
              <button
                type="button"
                onClick={dismissEmailConsent}
                disabled={emailBusy}
                className="btn-inset flex items-center justify-center rounded-full py-2 text-xs font-bold tracking-wide active:brightness-90 disabled:opacity-60"
              >
                {t("emailConsent.cancel")}
              </button>
              <button
                type="button"
                onClick={confirmEmailIntro}
                disabled={emailBusy || emailOutcome?.ok === true}
                className="flex items-center justify-center rounded-full bg-gradient-to-b from-[#ffe9c2] via-[#d7a05a] to-[#9e6a35] py-2 text-xs font-black tracking-wide text-[#2a1606] shadow-[inset_0_1px_0_rgba(255,255,255,0.5),0_6px_16px_rgba(0,0,0,0.45)] active:brightness-90 disabled:opacity-60"
              >
                {emailBusy ? t("emailConsent.sending") : t("emailConsent.confirm")}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
