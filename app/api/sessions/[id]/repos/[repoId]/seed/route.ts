import { access, canWrite, denied, forbidden } from "../../../../../../lib/session/auth";
import { ensureRepoContext } from "../../../../../../lib/knowledge/repo-context";
import { finishSeed, writeSeedBatch, withRepoLock } from "../../../../../../lib/session/repo";
import { finishRoomRepoSeed, getRoomRepo } from "../../../../../../lib/session/roomRepos";
import type { SeedRequest } from "../../../../../../lib/session/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_FILES_PER_BATCH = 500;

export type RoomRepoSeedResponse = {
  written: number;
  skipped: string[];
  /** Set on the final batch, once the import is committed. */
  headSha: string | null;
};

/**
 * Uploads a picked folder into one of the room's imported repos, in batches,
 * then commits it — the same contract as the session seed route, but keyed by
 * the repo's own id (which is all the git layer needs). Seeding is once-only
 * per repo: after the first commit the repo is the record, exactly like a
 * session's.
 */
export async function POST(
  request: Request,
  context: RouteContext<"/api/sessions/[id]/repos/[repoId]/seed">,
) {
  const { id, repoId } = await context.params;
  const result = await access(id);
  const refusal = denied(result);
  if (refusal || !result) return refusal!;

  if (!canWrite(result.role)) {
    return forbidden("Importing a repo changes the room, which needs edit access.");
  }

  const repo = await getRoomRepo(repoId);
  if (!repo || repo.sessionId !== id) {
    return Response.json({ error: "That repo isn't in this room." }, { status: 404 });
  }
  if (repo.createdBy !== result.user.id) return forbidden("Only the importing member can upload this repository.");

  let body: SeedRequest;
  try {
    body = (await request.json()) as SeedRequest;
  } catch {
    return Response.json({ error: "Expected a JSON body." }, { status: 400 });
  }

  if (!body || !Array.isArray(body.files) || body.files.some(file => !file || typeof file.path !== "string" || typeof file.data !== "string")) {
    return Response.json({ error: "Expected a files array." }, { status: 400 });
  }
  const files = body.files;
  if (files.length > MAX_FILES_PER_BATCH) {
    return Response.json(
      { error: `Send at most ${MAX_FILES_PER_BATCH} files per batch.` },
      { status: 413 },
    );
  }

  return withRepoLock(repoId, async () => {
  const current = await getRoomRepo(repoId);
  if (current?.seededAt) return Response.json({ written: 0, skipped: [], headSha: current.headSha } satisfies RoomRepoSeedResponse);
  const { written, skipped } = await writeSeedBatch(repoId, files);

  if (!body.done) {
    return Response.json({ written, skipped, headSha: null } satisfies RoomRepoSeedResponse);
  }

  const seeded = await finishSeed(repoId, repo.rootName);
  const upstream = typeof body.upstreamUrl === "string" ? body.upstreamUrl : null;
  await finishRoomRepoSeed(repoId, { headSha: seeded.headSha, upstreamUrl: upstream });
  await ensureRepoContext(repoId, seeded.headSha);

  return Response.json({ written, skipped, headSha: seeded.headSha } satisfies RoomRepoSeedResponse);
  });
}
