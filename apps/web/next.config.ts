import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: "export",
  trailingSlash: true,
  reactStrictMode: true,
  typedRoutes: true,
  transpilePackages: ["@micracode/shared"],
};

export default nextConfig;
