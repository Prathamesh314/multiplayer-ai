import { withApiLimit } from "../../../../../lib/http/api-limit";
import { limitedJson } from "../../../../../lib/http/body";
import { events } from "../../../../../lib/events";
import { access, canWrite, denied, forbidden } from "../../../../../lib/session/auth";
import { withRepoLock } from "../../../../../lib/session/repo";
import { deleteRoomRepo, removeRoomRepoFiles, RoomRepoError, setRoomRepoVisibility } from "../../../../../lib/session/roomRepos";
import { resourceFor, resourceUsage, settle, storageOwner } from "../../../../../lib/storage/accounting";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
type Context = { params: Promise<{ id: string; repoId: string }> };

const failure = (error: unknown) => {
  if (error instanceof RoomRepoError) return Response.json({ error: error.message }, { status: error.status });
  throw error;
};

/** Its creator makes a repository private (`{ visibility: "private" }`) or visible to the room (`"room"`). */
async function handlePATCH(request: Request, context: Context) {
  const { id, repoId } = await context.params;
  const result = await access(id);
  const refusal = denied(result);
  if (refusal || !result) return refusal!;
  if (!canWrite(result.role)) return forbidden("Edit access is required.");
  const body = (await limitedJson(request, 1024).catch(() => null)) as { visibility?: unknown } | null;
  try {
    const repo = await setRoomRepoVisibility(id, repoId, result.user.id, body?.visibility);
    await (await events()).publish(id, { type: "repos.changed", repoId, at: Date.now() }).catch(() => {});
    return Response.json({ repo });
  } catch (error) {
    return failure(error);
  }
}

/** Delete a repository from the room, with its chats; a project's own copy is untouched. */
async function handleDELETE(_request: Request, context: Context) {
  const { id, repoId } = await context.params;
  const result = await access(id);
  const refusal = denied(result);
  if (refusal || !result) return refusal!;
  if (!canWrite(result.role)) return forbidden("Edit access is required.");
  const owner = await storageOwner(repoId).catch(() => null);
  try {
    const { chats } = await deleteRoomRepo({ sessionId: id, repoId, userId: result.user.id, roomOwner: result.role === "owner" });
    // The record is gone, so nothing reaches these files any more; free their space.
    await withRepoLock(repoId, async () => {
      await removeRoomRepoFiles(repoId);
      if (owner) {
        const resource = resourceFor(`repo:${repoId}`, owner);
        await resourceUsage(resource);
        await settle(resource, { bytes: 0, anomaly: null });
      }
    }).catch((cause) => console.error("Room repository files remain after delete", repoId, cause));
    await (await events()).publish(id, { type: "repos.changed", repoId, at: Date.now() }).catch(() => {});
    return Response.json({ deleted: true, chats });
  } catch (error) {
    return failure(error);
  }
}

export const PATCH = withApiLimit("/api/sessions/[id]/repos/[repoId]", handlePATCH);
export const DELETE = withApiLimit("/api/sessions/[id]/repos/[repoId]", handleDELETE);
