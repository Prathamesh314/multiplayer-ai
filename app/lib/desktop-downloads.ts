/** Public installer links are fixed when the marketing page is built. */
export function desktopDownloadUrl(value: string | undefined): string | null {
  if (!value?.trim()) return null;
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.username || url.password) return null;
    if (["example.com", "example.org", "example.net"].some(host => url.hostname === host || url.hostname.endsWith(`.${host}`))) return null;
    return url.href;
  } catch {
    return null;
  }
}
