import type { NextConfig } from "next";

// Enable only after the public asset hostname works through the CDN. Kept at
// build time so a failed DNS/CDN setup cannot alter an already running release.
const assetPrefix = process.env.NODE_ENV === "production" ? process.env.NEXT_PUBLIC_ASSET_PREFIX?.trim() : undefined;
if (assetPrefix) {
  const url = new URL(assetPrefix);
  if (url.protocol !== "https:" || url.username || url.password || url.port || url.pathname !== "/" || url.search || url.hash) {
    throw new Error("NEXT_PUBLIC_ASSET_PREFIX must be an HTTPS origin without a path, credentials, port or query.");
  }
}

const nextConfig: NextConfig = {
  assetPrefix: assetPrefix ? new URL(assetPrefix).origin : undefined,
  crossOrigin: assetPrefix ? "anonymous" : undefined,
  distDir: process.env.NEXT_TEST_DIST_DIR || ".next",
  // node-pty is a native addon; keep it external so the bundler doesn't try to
  // pull the `.node` binary through webpack/Turbopack — it's required at runtime
  // from node_modules instead.
  serverExternalPackages: ["node-pty", "tree-sitter", "tree-sitter-typescript", "tree-sitter-javascript", "tree-sitter-python", "tree-sitter-go", "tree-sitter-rust"],
};

export default nextConfig;
