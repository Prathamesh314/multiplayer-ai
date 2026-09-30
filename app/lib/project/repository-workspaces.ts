import { query } from "../db/client";
import { createRoomRepo, finishRoomRepoSeed, getRoomRepo, listRoomRepos, setRoomRepoHeadSha } from "../session/roomRepos";
import { ensureWork, initializeSharedRepository, publishRoom, forkRoomRepository, withRepoLock } from "../session/repo";
import { registerRoomRepository, type ProjectRepository } from "./repositories";
import { setHeadSha } from "../session/store";

/** Caller has checked both room write access and project membership. */
export async function attachProjectRepository(sessionId: string, repository: ProjectRepository, userId: string) {
  return withRepoLock(sessionId, async () => {
    let repo = (await listRoomRepos(sessionId)).find(row => row.projectRepositoryId === repository.id);
    if (repo?.seededAt) return repo;
    repo ??= await createRoomRepo({ sessionId, rootName: repository.name, createdBy: userId, projectRepositoryId: repository.id });
    const fork = await withRepoLock(repo.id, () => forkRoomRepository(repo.id, repository.id, repository.name));
    await finishRoomRepoSeed(repo.id, { headSha: fork.headSha, upstreamUrl: repository.upstreamUrl });
    await query(`UPDATE room_repos SET base_sha = $2 WHERE id = $1`, [repo.id, fork.baseShaAtFork]);
    return (await getRoomRepo(repo.id))!;
  });
}

/** Caller authorizes room write access and project edit access before calling. */
export async function publishSelectedRepository(input: {
  sessionId: string; repoId: string | null; projectId: string; name: string; createdBy: string; headSha: string;
}) {
  const ref = input.repoId ?? input.sessionId;
  const repositoryId = await withRepoLock(ref, async () => {
    const repositoryId = await registerRoomRepository(input);
    await ensureWork(ref, input.headSha);
    await initializeSharedRepository(ref, repositoryId, input.headSha);
    await query(`UPDATE project_repositories SET ready = true WHERE id = $1`, [repositoryId]);
    return repositoryId;
  });
  const outcome = await publishRoom(ref, repositoryId);
  if (outcome.ok) {
    if (input.repoId) await setRoomRepoHeadSha(input.repoId, outcome.sha);
    else await setHeadSha(input.sessionId, outcome.sha);
  }
  return { ...outcome, projectRepositoryId: repositoryId };
}
