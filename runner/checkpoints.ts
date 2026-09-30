import { copyFile, lstat, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { objectGit, objectText, withTemporaryIndex, commitTree } from "../app/lib/git/objects";
import type { Checkpoint } from "../app/lib/runner/checkpoint-types";

/** A private index captures files without staging anything in the user's index. */
export async function captureCheckpoint(work: string, cache: string, turnId: string, baseSha: string, sequence: number, previous?: string): Promise<Checkpoint | null> {
  const headSha = await objectText(work, ["rev-parse", "HEAD"]);
  await objectGit(work, ["merge-base", "--is-ancestor", baseSha, headSha]);
  const indexPath = resolve(work, await objectText(work, ["rev-parse", "--git-path", "index"]));
  const before = await readFile(indexPath);
  const exclusions = ["node_modules", ".next", "dist", "build", ".cache", "coverage"];
  const untracked = (await objectGit(work, ["ls-files", "--others", "--exclude-standard", "-z", "--", ".", ...exclusions.map(name => `:(glob,exclude)**/${name}/**`)])).toString().split("\0").filter(path => path && !/(^|\/)\.env(?:\.(?:local|development|production|test)(?:\.local)?)?$/.test(path));
  const tracked = (await objectGit(work, ["ls-files", "-z"])).toString().split("\0").filter(Boolean);
  let sourceBytes = 0;
  for (const path of new Set([...tracked, ...untracked])) {
    const info = await lstat(resolve(work, path)).catch((cause: NodeJS.ErrnoException) => { if (cause.code === "ENOENT") return null; throw cause; });
    if (info?.isFile()) { sourceBytes += info.size; if (info.size > 8 * 1024 * 1024 || sourceBytes > 256 * 1024 * 1024) throw new Error("Checkpoint exceeds the file (8 MB) or source-tree (256 MB) limit."); }
  }
  const trees = await withTemporaryIndex(cache, async env => {
    await copyFile(indexPath, env.GIT_INDEX_FILE!);
    const indexTree = await objectText(work, ["write-tree"], undefined, env);
    // Preserve the real staged state above, then capture all nonignored files.
    await objectGit(work, ["add", "-u"], undefined, env);
    if (untracked.length) await objectGit(work, ["--literal-pathspecs", "add", "--pathspec-from-file=-", "--pathspec-file-nul"], untracked.join("\0") + "\0", env);
    const tree = await objectText(work, ["write-tree"], undefined, env);
    const entries = (await objectText(cache, ["ls-tree", "-rlz", tree])).split("\0");
    let total = 0;
    for (const entry of entries) {
      const size = Number(entry.split("\t")[0].trim().split(/\s+/)[3]);
      if (Number.isFinite(size)) { total += size; if (size > 8 * 1024 * 1024 || total > 256 * 1024 * 1024) throw new Error("Checkpoint exceeds the file (8 MB) or source-tree (256 MB) limit."); }
    }
    return { indexTree, tree };
  });
  if (!before.equals(await readFile(indexPath)) || headSha !== await objectText(work, ["rev-parse", "HEAD"])) throw new Error("Repository changed during checkpoint capture; retrying next interval.");
  if (`${trees.tree}:${trees.indexTree}:${headSha}` === previous) return null;
  const indexSha = await commitTree(cache, trees.indexTree, [headSha], "Checkpoint staged state");
  const snapshotSha = await commitTree(cache, trees.tree, [headSha, indexSha], "Checkpoint working files");
  return { id: randomUUID(), turnId, sequence, baseSha, headSha, indexSha, snapshotSha, capturedAt: new Date().toISOString() };
}

/** Restore only into a verified clean checkout; protect ignored files too. */
export async function restoreCheckpoint(work: string, snapshot: Checkpoint): Promise<void> {
  if ((await objectText(work, ["status", "--porcelain", "--untracked-files=all"])).trim()) throw new Error("Local edits must be saved or moved before restoring a checkpoint.");
  const existing = (await objectGit(work, ["ls-files", "--others", "--ignored", "--exclude-standard", "-z"])).toString().split("\0").filter(Boolean);
  const incoming = (await objectGit(work, ["ls-tree", "-r", "--name-only", "-z", snapshot.snapshotSha])).toString().split("\0").filter(Boolean);
  if (existing.some(path => incoming.some(file => file === path || file.startsWith(path + "/") || path.startsWith(file + "/")))) throw new Error("An ignored local file would be overwritten by this checkpoint. Move it before restoring.");
  await objectGit(work, ["merge", "--ff-only", "--no-autostash", "--no-overwrite-ignore", snapshot.headSha]);
  await objectGit(work, ["read-tree", "-m", "-u", "HEAD", snapshot.snapshotSha]);
  await objectGit(work, ["read-tree", snapshot.indexSha]);
}
