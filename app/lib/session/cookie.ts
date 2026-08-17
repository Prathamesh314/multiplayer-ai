import { cookies } from "next/headers";

const COOKIE_NAME = "ma_session_keys";
const MAX_AGE_SECONDS = 60 * 60 * 24 * 30;
/** Keeps the cookie well inside the 4 KB per-cookie limit. */
const MAX_TRACKED = 40;

/**
 * Session keys are kept in one httpOnly cookie, `{ sessionId: key }`.
 *
 * This is what makes a copied URL useless: the id travels in the address bar,
 * the key never does. Page scripts cannot read the cookie either, so the key
 * cannot be exfiltrated and pasted elsewhere.
 */
export async function readSessionKeys(): Promise<Record<string, string>> {
  const raw = (await cookies()).get(COOKIE_NAME)?.value;
  if (!raw) return {};

  try {
    const parsed: unknown = JSON.parse(Buffer.from(raw, "base64url").toString("utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};

    const keys: Record<string, string> = {};
    for (const [id, key] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof key === "string") keys[id] = key;
    }
    return keys;
  } catch {
    return {};
  }
}

export async function writeSessionKeys(keys: Record<string, string>): Promise<void> {
  // Newest entries win when trimming.
  const entries = Object.entries(keys).slice(-MAX_TRACKED);
  const encoded = Buffer.from(JSON.stringify(Object.fromEntries(entries)), "utf8").toString(
    "base64url",
  );

  (await cookies()).set(COOKIE_NAME, encoded, {
    httpOnly: true,
    sameSite: "lax",
    path: "/",
    maxAge: MAX_AGE_SECONDS,
    secure: process.env.NODE_ENV === "production",
  });
}

export async function grantSessionKey(id: string, key: string): Promise<void> {
  const keys = await readSessionKeys();
  await writeSessionKeys({ ...keys, [id]: key });
}

export async function revokeSessionKey(id: string): Promise<void> {
  const keys = await readSessionKeys();
  delete keys[id];
  await writeSessionKeys(keys);
}
