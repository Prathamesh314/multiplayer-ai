/** Only reviewed, public screenshots use the asset CDN. Never pass user files. */
export function publicAsset(path: string): string {
  const prefix = process.env.NODE_ENV === "production" ? process.env.NEXT_PUBLIC_ASSET_PREFIX?.trim().replace(/\/+$/, "") : "";
  if (!/^\/(product|docs\/images)\/[a-z0-9-]+\.(png|webp)$/.test(path)) return path;
  return prefix ? prefix + path : path;
}
