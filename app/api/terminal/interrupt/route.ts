import { terminalAccess } from "../../../lib/terminal/guard";
import { interrupt } from "../../../lib/terminal/registry";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Ctrl+C: sends SIGINT to a running command's process group. */
export async function POST(request: Request) {
  const access = terminalAccess(request);
  if (!access.allowed) {
    return Response.json({ error: access.reason }, { status: 403 });
  }

  let runId: unknown;
  try {
    ({ runId } = (await request.json()) as { runId?: unknown });
  } catch {
    return Response.json({ error: "Expected a JSON body." }, { status: 400 });
  }

  if (typeof runId !== "string" || runId.length === 0) {
    return Response.json({ error: "runId is required." }, { status: 400 });
  }

  return Response.json({ interrupted: interrupt(runId) });
}
