import type { NextConfig } from "next";

// Strangler shell (ADR-009, milestone M2): Next.js owns the domain. The
// legacy single-file app keeps serving at its old URL until each page is
// rebuilt: `/` rewrites to the copy of index.html that scripts/sync-legacy.mjs
// places under public/legacy at build time, and the existing Vercel functions
// in api/ keep answering /api/*. New server routes live under app/api/<name>
// and must never reuse a legacy function's path until that function retires.
const nextConfig: NextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  async rewrites() {
    return [{ source: "/", destination: "/legacy/index.html" }];
  },
  async headers() {
    return [
      {
        source: "/(.*)",
        headers: [
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          { key: "X-Frame-Options", value: "DENY" },
        ],
      },
    ];
  },
};

export default nextConfig;
