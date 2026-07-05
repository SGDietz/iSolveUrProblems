import createNextIntlPlugin from "next-intl/plugin";

const withNextIntl = createNextIntlPlugin("./src/i18n/request.ts");

/** @type {import('next').NextConfig} */
const nextConfig = {
  transpilePackages: ["@heygen/liveavatar-web-sdk"],
  eslint: {
    // Avoid build failure when repo has eslint.config.js importing missing @repo/eslint-config
    ignoreDuringBuilds: true,
  },
  // NOTE: an experimental `proxyClientMaxBodySize: "10mb"` used to sit here
  // for /api/analyze-image uploads, but it is not a real Next.js option (the
  // build warned "invalid next.config.js key" and ignored it). App Router
  // route handlers have no body-size cap by default; the upload limit is
  // enforced in-route via MAX_ANALYZE_IMAGE_BYTES. Removed 2026-07-02.
};

export default withNextIntl(nextConfig);
