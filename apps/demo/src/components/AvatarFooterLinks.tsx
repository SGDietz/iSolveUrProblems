"use client";

import { useTranslations } from "next-intl";
import { Link } from "../i18n/routing";

/**
 * The avatar screen's own footer line — Ai Guarantee / copyright / Terms /
 * Privacy, each a real link to its own page (G 2026-07-08: "right now the
 * Ai Guarantee goes to Terms page. make all the buttons work properly").
 * Previously the whole line was ONE <Link href="/terms"> wrapping a single
 * translated string, so every word went to the same place.
 *
 * `brand-grad-text` lives ONLY on the outer <p> — -webkit-text-fill-color
 * inherits into the <Link> children the same way `color` would, so the
 * gradient paints through them without needing the class repeated on each
 * one. Putting `brand-grad-text` on each Link individually would give each
 * a separate, independent gradient sweep instead of one continuous line.
 */
export function AvatarFooterLinks({ className }: { className?: string }) {
  const t = useTranslations("home");
  return (
    <p
      className={`brand-grad-text block text-center text-[10px] sm:text-[11px] whitespace-nowrap ${className ?? ""}`}
    >
      <Link href="/ai-guarantee" target="_blank" className="hover:opacity-90 transition-opacity">
        {t("footerGuarantee")}
      </Link>
      {" · "}
      {t("footerCopyright")}
      {" · "}
      <Link href="/legal" target="_blank" className="hover:opacity-90 transition-opacity">
        {t("footerTerms")}
      </Link>
      {" · "}
      <Link href="/privacy" target="_blank" className="hover:opacity-90 transition-opacity">
        {t("footerPrivacy")}
      </Link>
    </p>
  );
}
