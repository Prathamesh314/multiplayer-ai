import { agentById } from "../../../../../lib/ai/catalog";
import { finalizeAgentRun } from "../../../../../lib/ai/finalize";
import { publishRunEvent } from "../../../../../lib/ai/run-stream";
import { verifyPushedCommit } from "../../../../../lib/session/repo";
import { bearerToken, deviceFromToken } from "../../../../../lib/runner/devices";
import { claimedJob, completeJob } from "../../../../../lib/runner/jobs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export type RunnerCompleteRequest = {
  code: number | null;
  /** The commit the run pushed over smart-HTTP, or null when nothing changed. */
  resultSha: string | null;
  output: string;
  errOutput: string;
  ms: number;
};

/** Mirror the executor's output caps; a rogue report cannot blow the transcript. */
const MAX_OUTPUT_BYTES = 2 * 1024 * 1024;
const MAX_ERR_BYTES = 256 * 1024;

/**
 * The runner's terminal report. The runner states facts — exit code, the
 * commit it pushed, the captured output — and the server does everything
 * durable through the same finalization the server executor uses, so a local
 * run is indistinguishable from a cloud one from the transcript out.
 *
 * The one thing taken on faith nowhere: `resultSha` is verified against the
 * bare repo (present *and* descended from the run's base) before any head
 * moves. A runner cannot claim a commit it never pushed.
 */
export async function POST(request: Request, context: RouteContext<"/api/runner/runs/[runId]/complete">) {
  const device = await deviceFromToken(bearerToken(request));
  if (!device) {
    return Response.json({ error: "Unknown or revoked device token." }, { status: 401 });
  }

  const { runId } = await context.params;
  const job = await claimedJob(runId, device.id);
  if (!job) return Response.json({ error: "Not your claimed run." }, { status: 404 });

  let body: RunnerCompleteRequest;
  try {
    body = (await request.json()) as RunnerCompleteRequest;
  } catch {
    return Response.json({ error: "Expected a JSON body." }, { status: 400 });
  }

  const code = typeof body.code === "number" ? body.code : null;
  const output = typeof body.output === "string" ? body.output.slice(0, MAX_OUTPUT_BYTES) : "";
  const errOutput = typeof body.errOutput === "string" ? body.errOutput.slice(0, MAX_ERR_BYTES) : "";
  const ms = Math.max(0, Number(body.ms) || 0);

  const repoRef = job.repoId ?? job.sessionId;
  let sha: string | null = null;
  if (body.resultSha != null) {
    if (typeof body.resultSha !== "string") {
      return Response.json({ error: "resultSha must be a commit id or null." }, { status: 400 });
    }
    const verified = await verifyPushedCommit(repoRef, job.baseSha, body.resultSha);
    if (!verified) {
      return Response.json(
        { error: "That commit isn't in the repo, or doesn't extend the run's base." },
        { status: 400 },
      );
    }
    sha = body.resultSha;
  }

  const finalized = await finalizeAgentRun({
    sessionId: job.sessionId,
    runId,
    repoId: job.repoId,
    baseSha: job.baseSha,
    userPrompt: job.userPrompt,
    binName: agentById(job.agentId)?.bin ?? job.agentId,
    author: job.author,
    sha,
    code,
    output,
    errOutput,
    onError: (message) => void publishRunEvent(runId, { t: "err", d: message }).catch(() => {}),
  });

  // The terminal frame the driver's stream closes on — always the server's to
  // send, and only after the report checked out.
  await publishRunEvent(runId, {
    t: "exit",
    code,
    ms,
    headSha: sha,
    committed: sha !== null,
    changes: finalized.changes.length > 0 ? finalized.changes : undefined,
  }).catch(() => {});

  await completeJob(runId, device.id);
  return Response.json({ ok: true });
}
