import type { AgentRun } from "./runs";
import type { Session } from "../session/types";
import { memberRoleOf } from "../project/store";
import { getProjectRepository, projectRepositoryForRoom } from "../project/repositories";
import { attachProjectRepository } from "../project/repository-workspaces";
import { ensureMemberRoom } from "../session/memberRoom";

export type ForkTarget = { sessionId: string; repoId: string | null };

/**
 * Where forking a chat starts the new chat: the caller's own room in the
 * project, with the chat's project repository brought into it when it was
 * working on one. Outside a project, or for someone not added to it (or a
 * viewer), the fork stays in the chat's room as before.
 */
export async function forkTargetFor(session: Pick<Session, "id" | "projectId" | "orgId">, run: Pick<AgentRun, "sessionId" | "repoId">, user: { id: string; handle: string }): Promise<ForkTarget> {
  const here: ForkTarget = { sessionId: session.id, repoId: run.repoId };
  if (!session.projectId || !session.orgId) return here;
  const role = await memberRoleOf(session.projectId, user.id);
  if (!role || role === "viewer") return here;
  const room = await ensureMemberRoom({ id: session.projectId, orgId: session.orgId }, user.id, role, user.handle).catch(() => null);
  if (!room || room.id === session.id) return here;
  let repoId: string | null = null;
  const shared = await projectRepositoryForRoom(run.sessionId, run.repoId);
  if (shared && shared !== await projectRepositoryForRoom(room.id, null)) {
    const repository = await getProjectRepository(shared);
    if (repository?.ready) repoId = (await attachProjectRepository(room.id, repository, user.id).catch(() => null))?.id ?? null;
  }
  return { sessionId: room.id, repoId };
}
