import { currentUser } from "../../../lib/auth/tokens";
import { createPairingCode } from "../../../lib/runner/devices";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export type PairingCodeResponse = { code: string; expiresAt: number };

/**
 * Mint a pairing code for the signed-in user — step one of connecting a
 * computer. The code appears once, here; the runner exchanges it at
 * /api/runner/pair. Ten minutes, single use.
 */
export async function POST() {
  const user = await currentUser();
  if (!user) return Response.json({ error: "Sign in to continue." }, { status: 401 });

  const minted = await createPairingCode(user.id);
  return Response.json(minted satisfies PairingCodeResponse, {
    headers: { "cache-control": "no-store" },
  });
}
