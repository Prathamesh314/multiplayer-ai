import { access, denied, forbidden } from "../../../../lib/session/auth";
import { ensureRepoContext } from "../../../../lib/knowledge/repo-context";
import { finishSeed, writeSeedBatch } from "../../../../lib/session/repo";
import { attachRepo } from "../../../../lib/session/store";
import type { SeedRequest, SeedResponse } from "../../../../lib/session/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_FILES_PER_BATCH = 500;

/**
 * Uploads the picked folder in batches, then commits it. Only the owner can
 * seed, and only once: after the session branch exists the repo is the record
 * and further changes go through the file route as commits.
 */
export async function POST(request: Request, context: RouteContext<"/api/sessions/[id]/seed">) {
  const { id } = await context.params;
  const result = await access(id);
  const refusal = denied(result);
  if (refusal || !result) return refusal!;

  if (result.role !== "owner") {
    return forbidden("Only the session owner can add the folder.");
  }
  if (result.session.projectId && !result.session.repo) {
    return Response.json({ error: "Import a repository through the room repository picker." }, { status: 409 });
  }
  if (result.session.repo) {
    return Response.json({ error: "This session already holds a repository." }, { status: 409 });
  }

  let body: SeedRequest;
  try {
    body = (await request.json()) as SeedRequest;
  } catch {
    return Response.json({ error: "Expected a JSON body." }, { status: 400 });
  }

  const files = Array.isArray(body.files) ? body.files : [];
  if (files.length > MAX_FILES_PER_BATCH) {
    return Response.json(
      { error: `Send at most ${MAX_FILES_PER_BATCH} files per batch.` },
      { status: 413 },
    );
  }

  const { written, skipped } = await writeSeedBatch(id, files);

  if (!body.done) {
    return Response.json({ written, skipped, repo: null } satisfies SeedResponse);
  }

  const rootName = typeof body.rootName === "string" ? body.rootName.trim() : "";
  const repo = await finishSeed(id, rootName || result.session.name);
  const upstream = typeof body.upstreamUrl === "string" ? body.upstreamUrl : null;
  const updated = await attachRepo(id, repo, upstream);
  if (!result.session.projectId) await ensureRepoContext(id, repo.headSha);

  return Response.json({
    written,
    skipped,
    repo: updated?.repo ?? repo,
  } satisfies SeedResponse);
}
