/** Keep post-login navigation on this site, including when URLs are encoded. */
export function safeReturnPath(value: string | null | undefined): string {
  const fallback = "/workspace";
  if (!value || value.length > 4096 || !value.startsWith("/")) return fallback;
  try {
    const decoded = decodeURIComponent(value);
    if ([value, decoded].some(path => path.startsWith("//") || /[\\\u0000-\u0020\u007f]/.test(path))) return fallback;
    const url = new URL(value, "https://workspace.invalid");
    if (url.origin !== "https://workspace.invalid") return fallback;
    const normalized = url.pathname + url.search + url.hash;
    // Removing dot segments can expose a leading // that the router would
    // interpret as a new origin when it parses the returned path again.
    if ([normalized, decodeURIComponent(normalized)].some(path => path.startsWith("//"))) return fallback;
    return normalized;
  } catch {
    return fallback;
  }
}

export function loginHref(returnTo: string): string {
  return `/login?${new URLSearchParams({ next: safeReturnPath(returnTo) })}`;
}

/**
 * Leave for the sign-in page with a full page load, never a client-side
 * route change. The sign-in form needs Clerk's provider, which the root layout
 * mounts only when the publishable key is present where that layout was
 * rendered. A prerendered page can carry a layout from build time without it,
 * and a client-side change keeps that layout. A full load renders /login, a
 * dynamic page, with the server's runtime configuration and starts the
 * client's auth state afresh, which is also what a sign-out needs.
 */
export function openSignIn(href = "/login"): void {
  window.location.replace(href);
}
