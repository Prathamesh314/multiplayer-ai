/**
 * A share link carries the access code so one URL is enough to open a session.
 *
 * The code goes in the fragment, never the query string. Fragments are not sent
 * to the server, so the code stays out of request logs, proxy logs and the
 * `Referer` header of anything the page later loads. It is still a secret in a
 * URL — see `InviteDialog` for what that costs — but this is the cheapest place
 * to put one.
 */
const SHARE_KEY = "k";

export function buildShareLink(sessionId: string, token: string): string {
  const path = `/s/${sessionId}#${SHARE_KEY}=${encodeURIComponent(token)}`;
  return typeof window === "undefined" ? path : `${window.location.origin}${path}`;
}

/**
 * Distinguishes a generated link token from the short typed code.
 *
 * Links minted before share links existed carry a join code in the same
 * fragment, so the shape has to decide which field to send rather than the
 * caller assuming.
 */
export function isJoinCode(secret: string): boolean {
  return /^[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}$/.test(secret.trim().toUpperCase());
}

/** The access code in the current URL fragment, if this is a share link. */
export function readShareCode(): string | null {
  if (typeof window === "undefined") return null;
  return codeFromFragment(window.location.hash);
}

/**
 * Drops the code from the address bar once it has been redeemed, so it is not
 * left sitting in history or copied out of the URL by the person who opened it.
 */
export function clearShareCode(): void {
  if (typeof window === "undefined" || !window.location.hash) return;
  window.history.replaceState(null, "", window.location.pathname + window.location.search);
}

const STASH_KEY = "ma_pending_share";

/**
 * Holds the code across a trip through sign-in.
 *
 * A share link now requires an account, and the fragment does not survive the
 * round trip to /login — so without this, following a link while signed out
 * lands on a locked screen asking for a code the link already contained.
 */
export function stashShareCode(sessionId: string, code: string): void {
  if (typeof window === "undefined") return;
  try {
    window.sessionStorage.setItem(STASH_KEY, JSON.stringify({ sessionId, code }));
  } catch {
    // Private browsing with storage disabled: the locked screen still works.
  }
}

/** Reads and clears, so a stale code cannot be replayed on a later visit. */
export function takeStashedShareCode(sessionId: string): string | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.sessionStorage.getItem(STASH_KEY);
    if (!raw) return null;
    window.sessionStorage.removeItem(STASH_KEY);
    const stashed = JSON.parse(raw) as { sessionId?: string; code?: string };
    return stashed.sessionId === sessionId && stashed.code ? stashed.code : null;
  } catch {
    return null;
  }
}

/** Splits a pasted share link into its parts. Either half may be missing. */
export function parseShareLink(input: string): { id: string | null; code: string | null } {
  const trimmed = input.trim();
  const hashAt = trimmed.indexOf("#");

  const id = /\/s\/([a-z2-9]{12})/i.exec(trimmed)?.[1] ?? null;
  const code = hashAt < 0 ? null : codeFromFragment(trimmed.slice(hashAt));

  return { id, code };
}

function codeFromFragment(fragment: string): string | null {
  const params = new URLSearchParams(fragment.replace(/^#/, ""));
  const code = params.get(SHARE_KEY)?.trim();
  return code && code.length > 0 ? code : null;
}
