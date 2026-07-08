"use client";

import { Link, usePathname } from "../i18n/routing";

/**
 * Global legal-links footer. Hidden on the avatar root screen ("/") —
 * LiveAvatarSession renders its own fixed-position footer link there
 * (G 2026-07-08: "the bottom of the avatar already has the privacy and
 * other buttons, they work we need to keep them"). Rendering both would
 * stack two fixed-bottom elements on the same screen.
 */
export function SiteFooter() {
  const pathname = usePathname();
  if (pathname === "/") return null;

  return (
    <footer className="fixed inset-x-0 bottom-0 z-30 border-t border-[#e0aa62]/30 bg-gradient-to-b from-[#130a03]/95 to-[#0a0604]/98 px-4 py-3 text-center text-xs text-[#f1c477]/80 backdrop-blur-sm sm:text-sm">
      <p className="mb-1.5">&copy; 2026 iSolveUrProblems.ai &mdash; All Rights Reserved</p>
      <nav className="flex flex-wrap items-center justify-center gap-2 sm:gap-3">
        <Link href="/legal" className="transition-colors hover:text-[#ffe9c2]">
          Terms
        </Link>
        <span aria-hidden="true">&middot;</span>
        <Link href="/privacy" className="transition-colors hover:text-[#ffe9c2]">
          Privacy
        </Link>
        <span aria-hidden="true">&middot;</span>
        <Link href="/legal" className="transition-colors hover:text-[#ffe9c2]">
          Legal
        </Link>
      </nav>
    </footer>
  );
}
