import type { NextConfig } from "next";

/**
 * Dev/test client for the Rust `micracode-api` backend. Unlike `apps/web` this
 * app is not statically exported into the Electron shell — it's run with
 * `next dev` / `next start` on port 3000 (the origin the backend's CORS
 * allow-list defaults to), so the config stays minimal.
 */
const nextConfig: NextConfig = {
  reactStrictMode: true,
};

export default nextConfig;
