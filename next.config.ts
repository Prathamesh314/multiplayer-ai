import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // node-pty is a native addon; keep it external so the bundler doesn't try to
  // pull the `.node` binary through webpack/Turbopack — it's required at runtime
  // from node_modules instead.
  serverExternalPackages: ["node-pty"],
};

export default nextConfig;
