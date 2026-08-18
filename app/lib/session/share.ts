import type { Session } from "./types";

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

export function buildShareLink(session: Session): string {
  const path = `/s/${session.id}#${SHARE_KEY}=${encodeURIComponent(session.joinCode)}`;
  return typeof window === "undefined" ? path : `${window.location.origin}${path}`;
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
