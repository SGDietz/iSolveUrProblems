import "./globals.css";
import Link from "next/link";
import { AuthProvider } from "../src/lib/auth/AuthProvider";

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body className="site-bg flex min-h-screen flex-col text-white justify-center items-center">
        {/* <main className="w-full flex-1">{children}</main> */}
        <AuthProvider>{children}</AuthProvider>
        {/* <footer className="w-full border-t border-white/10 px-4 py-4 text-center text-xs sm:text-sm text-zinc-300">
          <p className="mb-2">© 2026 iSolveUrProblems.ai — All Rights Reserved</p>
          <nav className="flex flex-wrap items-center justify-center gap-2 sm:gap-3">
            <Link href="/terms" className="hover:text-white transition-colors">
              Terms
            </Link>
            <span aria-hidden="true">•</span>
            <Link href="/privacy" className="hover:text-white transition-colors">
              Privacy
            </Link>
            <span aria-hidden="true">•</span>
            <Link href="/disclaimer" className="hover:text-white transition-colors">
              Disclaimer
            </Link>
            <span aria-hidden="true">•</span>
            <Link href="/legal" className="hover:text-white transition-colors">
              Legal
            </Link>
          </nav>
        </footer> */}
      </body>
    </html>
  );
}
