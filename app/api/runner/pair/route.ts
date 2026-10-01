import { withApiLimit } from "../../../lib/http/api-limit";
import { exchangePairingCode } from "../../../lib/runner/devices";
import type { RunnerDevice } from "../../../lib/runner/devices";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export type PairRequest = { code: string; name: string; platform?: string; version?: string };
export type PairResponse = { device: RunnerDevice; token: string };

/**
 * Exchange a pairing code for a device token — step two, called by the runner
 * itself. No web session here: the code *is* the credential, minted moments
 * ago by a signed-in browser. The token in this response is shown exactly
 * once; the server keeps only its hash.
 */
async function handlePOST(request: Request) {
  let body: PairRequest;
  try {
    body = (await request.json()) as PairRequest;
  } catch {
    return Response.json({ error: "Expected a JSON body." }, { status: 400 });
  }

  const code = typeof body.code === "string" ? body.code.trim() : "";
  const name = typeof body.name === "string" ? body.name.trim() : "";
  if (!code || !name || name.length > 100) {
    return Response.json({ error: "Send the pairing code and a device name." }, { status: 400 });
  }

  const paired = await exchangePairingCode({
    code,
    name,
    platform: typeof body.platform === "string" ? body.platform.slice(0, 40) : null,
    version: typeof body.version === "string" ? body.version.slice(0, 40) : null,
  });
  if (!paired) {
    return Response.json(
      { error: "That pairing code is invalid, used, or expired. Mint a fresh one." },
      { status: 403 },
    );
  }

  return Response.json(paired satisfies PairResponse, {
    headers: { "cache-control": "no-store" },
  });
}

export const POST = withApiLimit("/api/runner/pair", handlePOST);
