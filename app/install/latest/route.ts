import { desktopDownloadUrl } from "../../lib/desktop-downloads";

export const dynamic = "force-dynamic";

/**
 * The current desktop release's folder, read by /install.sh and /install.ps1:
 * the directory of the published SHA256SUMS.txt, whose files they verify.
 */
export function GET() {
  const checksums = desktopDownloadUrl(process.env.DESKTOP_DOWNLOAD_CHECKSUMS_URL);
  const headers = { "content-type": "text/plain; charset=utf-8", "cache-control": "public, max-age=60" };
  if (!checksums) return new Response("Multicode AI downloads are not available yet.\n", { status: 404, headers: { ...headers, "cache-control": "no-store" } });
  return new Response(`${new URL(".", checksums).href}\n`, { headers });
}
