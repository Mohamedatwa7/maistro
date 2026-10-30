import type { ReactNode } from "react";

export const metadata = {
  title: "MAISTRO",
  description: "A→Z content creation platform · Samsung Gulf",
  icons: { icon: [{ url: "/assets/favicon.svg?v=3", type: "image/svg+xml" }, { url: "/favicon.ico?v=3", sizes: "any" }], apple: "/assets/apple-touch-icon.png?v=3" },
};

// Root layout for the pages that replace the legacy app one by one
// (MIGRATION_PLAN M5–M8). The legacy page at `/` is served by a rewrite and
// does not pass through here.
export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" dir="auto">
      <body style={{ margin: 0, background: "#000", color: "#e5e7eb", fontFamily: "Inter, system-ui, sans-serif" }}>{children}</body>
    </html>
  );
}
