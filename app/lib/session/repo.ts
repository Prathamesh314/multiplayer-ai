/** Public GitService boundary. All server Git operations hydrate through the
 * runtime-selected backend and acknowledge mutations only after durable save. */
import * as local from "./repo-local";
import { gitStorageConfig, repoKey, type RepoKey } from "../git-storage/config";
import { gitStorageService, storageGit, withGitRepositories } from "../git-storage/service";
import { workPath } from "./paths";
import { rm } from "node:fs/promises";

export type { MergeResult, SeedOutcome, RepoFile, SaveResult, FileChange } from "./repo-local";
export const BASE_BRANCH = local.BASE_BRANCH;
export const sessionBranchOf = local.sessionBranchOf;
export const gitAvailable = local.gitAvailable;
function operation<A extends unknown[], R>(fn: (...args: A) => Promise<R>, write: boolean, keys: (...args: A) => RepoKey[]) {
  return (...args: A): Promise<R> => withGitRepositories(keys(...args),write,() => fn(...args));
}
const room = (id: string) => [repoKey(id)];
const project = (id: string) => [repoKey(id,true)];
const snapshot = (id: string) => [repoKey(id,!/^[a-z2-9]{12}$/.test(id))];
const both = (id: string, projectId: string) => [repoKey(id),repoKey(projectId,true)];

export async function withRepoLock<T>(id: string, task: () => Promise<T>): Promise<T> {
  if (gitStorageConfig().mode === "local") return local.withRepoLock(id,task);
  return withGitRepositories(room(id),false,task);
}
export const createRepo = operation(local.createRepo,true,room);
export const ensureProjectRepo = operation(local.ensureProjectRepo,true,project);
export const forkRoomFromProject = operation(local.forkRoomFromProject,true,both);
export const publishRoom = operation(local.publishRoom,true,both);
export const syncRoom = operation(local.syncRoom,true,both);
export const projectHeadSha = operation(local.projectHeadSha,false,project);
export const repoContainsCommit = operation(local.repoContainsCommit,false,snapshot);
export const repoSnapshotPaths = operation(local.repoSnapshotPaths,false,snapshot);
export const repoSnapshotDiff = operation(local.repoSnapshotDiff,false,snapshot);
export const repoSnapshotText = operation(local.repoSnapshotText,false,snapshot);
export const verifyPushedCommit = operation(local.verifyPushedCommit,false,room);
export const listProjectFiles = operation(local.listProjectFiles,false,project);
export const repoRefHeadSha = operation(local.repoRefHeadSha,false,room);
export const listRepoRefFiles = operation(local.listRepoRefFiles,false,room);
export const readRepoRefFileText = operation(local.readRepoRefFileText,false,room);
export const readProjectFileText = operation(local.readProjectFileText,false,project);
export const writeSeedBatch = operation(async (...args: Parameters<typeof local.writeSeedBatch>) => {
  const result = await local.writeSeedBatch(...args);
  if (gitStorageConfig().mode !== "local") {
    // Each upload batch must survive a node switch before finishSeed. These
    // commits are not indexed or advertised as approved session code yet.
    const work = workPath(args[0]);
    await storageGit(work,["add","-A"]);
    if ((await storageGit(work,["status","--porcelain"])).trim()) {
      await storageGit(work,["commit","-m","Stage folder upload"]);
      await storageGit(work,["push","origin","HEAD:refs/heads/main"]);
    }
  }
  return result;
},true,room);
export const finishSeed = operation(local.finishSeed,true,room);
export const listTree = operation(local.listTree,false,room);
export const diffStat = operation(local.diffStat,false,room);
export const diffStatBare = operation(local.diffStatBare,false,room);
export const diffFilesBare = operation(local.diffFilesBare,false,room);
export const listChangedFiles = operation(local.listChangedFiles,false,room);
export const readRepoFile = operation(local.readRepoFile,false,room);
export const readRepoBytes = operation(local.readRepoBytes,false,room);
export const headSha = operation(local.headSha,false,room);
export const writeRepoFile = operation(local.writeRepoFile,false,room);
export async function mergeSave(...args:Parameters<typeof local.mergeSave>) {
  if(gitStorageConfig().mode==='local') return local.mergeSave(...args);
  return withGitRepositories(room(args[0]),true,async()=>{
    const result=await local.mergeSave(args[0],args[1],args[2],args[3],args[4],args[5]);
    if(result.status!=='conflict') {
      await (await gitStorageService()).checkpoint(room(args[0]));
      await args[6]?.(result.headSha);
    }
    return result;
  });
}
export const commitWork = operation(local.commitWork,true,room);
export const checkoutHead = operation(local.checkoutHead,false,room);
export const ensureWork = operation(local.ensureWork,false,room);
export const prepareTurnWork = operation(local.prepareTurnWork,false,room);
export const commitTurnWork = operation(local.commitTurnWork,true,room);
export const promoteTurn = operation(local.promoteTurn,true,room);
export const listCommittedTree = operation(local.listCommittedTree,false,room);
export const readCommittedBytes = operation(local.readCommittedBytes,false,room);
export const committedChanges = operation(local.committedChanges,false,room);
export async function discardTurnWork(turnId:string) {
  if(!/^[0-9a-f-]{36}$/i.test(turnId)) throw new Error('Invalid turn ID.');
  if(gitStorageConfig().mode==='cloud') await rm(workPath(`turn-${turnId}`),{recursive:true,force:true});
}
