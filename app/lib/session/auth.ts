import { readSessionKeys } from "./cookie";
import { getSession, keyMatches, type StoredSession } from "./store";

/**
 * Unknown sessions and unauthorised ones get the same 403, so the URL cannot be
 * used to probe which session ids exist.
 */
export function locked(): Response {
  return Response.json(
    {
      error:
        "This session is not open on this device. Ask whoever created it for the access code — the link on its own does not grant access.",
    },
    { status: 403, headers: { "cache-control": "no-store" } },
  );
}

/** Returns the session only when this browser holds its key. */
export async function authorize(id: string): Promise<StoredSession | null> {
  const session = await getSession(id);
  if (!session) return null;

  const keys = await readSessionKeys();
  return keyMatches(session, keys[id]) ? session : null;
}
