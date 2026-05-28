import type { NextConfig } from "next";

/**
 * Headers required for StackBlitz WebContainers (Phase 3).
 *
 * COEP `require-corp` + COOP `same-origin` put the app in a
 * "cross-origin isolated" state so that `SharedArrayBuffer` is
 * available — WebContainers needs it.
 *
 * Consequence to remember:
 *   - Third-party `<img>`, `<script>`, `<iframe>` must send
 *     `Cross-Origin-Resource-Policy: cross-origin` (or be same-origin).
 */
const securityHeaders = [
  { key: "Cross-Origin-Embedder-Policy", value: "require-corp" },
  { key: "Cross-Origin-Opener-Policy", value: "same-origin" },
];

const nextConfig: NextConfig = {
  output: "export",
  trailingSlash: true,
  reactStrictMode: true,
  typedRoutes: true,
  transpilePackages: ["@micracode/shared", "@webcontainer/api"],
  async headers() {
    return [
      {
        source: "/:path*",
        headers: securityHeaders,
      },
    ];
  },
};

export default nextConfig;
