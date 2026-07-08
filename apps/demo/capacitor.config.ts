import type { CapacitorConfig } from "@capacitor/cli";

// Capacitor native-app shell for iSolveUrProblems (G 2026-06-29).
// WHY: native video froze 6 on iOS (the OS suspends the live avatar stream when
// the browser hands the screen to the phone camera). A native app gets the real
// OS camera via @capacitor/camera — no freeze, no browser limits.
//
// ARCHITECTURE: iSolve is server-heavy (70+ /api routes, SSR, next-intl
// middleware), so we do NOT static-export. The native shell LOADS the deployed
// Next.js app from `server.url` (full SSR/API intact) and layers native plugins
// (Camera) on top via Capacitor.isNativePlatform() checks in the web code.
//
// BUILD GATES (not code — external): iOS needs a Mac OR a cloud builder
// (Codemagic) + an Apple Developer account ($99/yr). Android needs JDK +
// Android Studio (installable on Windows) or the same cloud builder.
const config: CapacitorConfig = {
  appId: "ai.isolveurproblems.app",
  appName: "iSolveUrProblems",
  // Required by the CLI even when loading remotely; not used when server.url is a
  // remote URL. (If we ever bundle a static shell instead, point this at it.)
  webDir: "public",
  server: {
    // Set to the live deployment the app should load. Use the Vercel PREVIEW URL
    // for testing builds; switch to the production domain for a release build.
    // Left unset here on purpose so a build can't silently point at the wrong env.
    // url: "https://i-solve-ur-problems-demo-<latest>-team-dietz.vercel.app",
    androidScheme: "https",
    cleartext: false,
  },
};

export default config;
