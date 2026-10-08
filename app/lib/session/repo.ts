import { withStorageAdmission, requireStorageGrowth, repositoryStorageBytes } from "../storage/admission";
import { withStoredRepo } from "../storage/git-cache";
import { cachedGitRead } from "../git/read-cache";
import { filterImportIndex } from "../git/import-index";
import { objectGit, objectText, withTemporaryIndex, putBlob, putBlobs, commitTree } from "../git/objects";
import { execFile } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { mkdir, readFile, rm, stat, writeFile, lstat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { buildTree, type TreeEntry } from "../tree";
import type { TreeNode } from "../types";
import { repoLock } from "./lock";
import { barePath, isSessionId, sharedRepositoryBarePath, resolveInside, safeRelativePath, workPath } from "./paths";
import type { ChangedFile, SessionRepo } from "./types";

const run = promisify(execFile);

export const BASE_BRANCH = "main";

/** Mirrors the browser editor's cap so both sides truncate at the same point. */
const MAX_TEXT_BYTES = 2 * 1024 * 1024;
/** Files larger than this are dropped from a seed rather than committed. */
const MAX_SEED_FILE_BYTES = 8 * 1024 * 1024;

export function sessionBranchOf(id: string): string {
  return `session/${id}`;
}

/** Serialize all server writers on the shared filesystem, including across replicas. */
export async function withRepoLock<T>(id: string, task: () => Promise<T>): Promise<T> {
  const lock = await repoLock();
  return withStorageAdmission(id, () => lock.withLock(id, task));
}

/** Git children inherit the repository lock until the command actually exits. */
async function git(cwd: string, args: string[]): Promise<string> {
  return (await objectGit(cwd, ["-c", "core.autocrlf=false", "-c", "core.quotePath=false", ...args], undefined, {}, 64 * 1024 * 1024)).toString("utf8");
}

/** True when git exits non-zero, rather than throwing. */
async function gitOk(cwd: string, args: string[]): Promise<boolean> {
  try {
    await git(cwd, args);
    return true;
  } catch {
    return false;
  }
}

export async function gitAvailable(): Promise<boolean> {
  try {
    await run("git", ["--version"], { windowsHide: true });
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Creation
// ---------------------------------------------------------------------------

/**
 * Creates only the bare repository; imported files are written as Git objects.
 *
 * The bare repo is what a sandbox will clone later, which is why it exists even
 * though nothing remote is involved yet: it keeps `repo_url` meaningful for
 * every session, including folders the user opened with no Git remote at all.
 */
async function stored_createRepo(id: string): Promise<void> {
  const bare = barePath(id);
  await mkdir(dirname(bare), { recursive: true });
  await git(dirname(bare), ["init", "--bare", "-b", BASE_BRANCH, bare]);
}

// ---------------------------------------------------------------------------
// Project canonical repo — the single source of truth (Git/Branch model)
// ---------------------------------------------------------------------------


async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * Ensures the shared repository's canonical bare repo exists with an initial `main`.
 *
 * Idempotent: rooms call it on the way to forking, and only the first one does
 * any work. `main` starts as an empty root commit so a room always has a real
 * commit to fork from, even before anyone has published anything.
 */
async function stored_ensureSharedRepository(repositoryId: string): Promise<void> {
  const bare = sharedRepositoryBarePath(repositoryId);
  if (await exists(bare)) return;

  await mkdir(dirname(bare), { recursive: true });
  await git(dirname(bare), ["init", "--bare", "-b", BASE_BRANCH, bare]);

  const tree = await objectText(bare, ["mktree"], "");
  const sha = await commitTree(bare, tree, [], "Initialize repository");
  await git(bare, ["update-ref", `refs/heads/${BASE_BRANCH}`, sha]);
}

/**
 * Creates a room checkout of an explicitly selected shared repository. Its
 * bare repo starts at that repository's current `main`, and `session/<id>`
 * forks from there. The room keeps the shared repo as a `project` remote
 * for later publish and sync.
 *
 * This is the fork half of the Git/Branch model; publishRoom is the merge half.
 */
async function stored_forkRoomRepository(
  roomId: string,
  repositoryId: string,
  rootName: string,
): Promise<SessionRepo> {
  await ensureSharedRepository(repositoryId);
  const sharedBare = sharedRepositoryBarePath(repositoryId);
  const bare = barePath(roomId);
  const branch = sessionBranchOf(roomId);
  await mkdir(dirname(bare), { recursive: true });
  await requireStorageGrowth((await repositoryStorageBytes(`shared:${repositoryId}`)) * 2 + 2 * 1024 * 1024, roomId);
  if (!await exists(bare)) await git(dirname(bare), ["clone", "--bare", sharedBare, bare]);
  const baseSha = (await git(bare, ["rev-parse", BASE_BRANCH])).trim();
  await git(bare, ["update-ref", `refs/heads/${branch}`, baseSha]);
  return {
    rootName,
    baseBranch: BASE_BRANCH,
    baseShaAtFork: baseSha,
    sessionBranch: branch,
    headSha: baseSha,
    depLockfileHash: await lockfileHash(roomId),
    specDocSha: await specDocSha(roomId),
    containerImageDigest: null,
    lastTestStatus: "unknown",
    lastTestSha: null,
    seededAt: Date.now(),
  };
}

export type MergeResult =
  | { ok: true; sha: string }
  /** The room and project diverged on the same lines; nothing was changed. */
  | { ok: false; reason: "conflict"; files: string[] };

/** Merge committed objects without materializing a working directory. */
async function mergeObjects(bare: string, ours: string, theirs: string): Promise<MergeResult> {
  if (await gitOk(bare, ["merge-base", "--is-ancestor", theirs, ours])) return { ok: true, sha: ours };
  if (await gitOk(bare, ["merge-base", "--is-ancestor", ours, theirs])) return { ok: true, sha: theirs };
  let tree: string;
  try { tree = await objectText(bare, ["merge-tree", "--write-tree", "--name-only", "-z", ours, theirs]); }
  catch (cause) {
    const error = cause as { code?: number; stdout?: Buffer };
    if (error.code !== 1 || !error.stdout) throw cause;
    const records = error.stdout.toString().split("\0").slice(1);
    const end = records.indexOf("");
    return { ok: false, reason: "conflict", files: records.slice(0, end < 0 ? records.length : end) };
  }
  return { ok: true, sha: await commitTree(bare, tree.replace(/\0/g, ""), [ours, theirs], "Merge shared repository") };
}

async function mergeShared(roomId: string, repositoryId: string, publish: boolean): Promise<MergeResult> {
  return withRepoLock(roomId, () => withRepoLock(`shared:${repositoryId}`, async () => {
    const bare = barePath(roomId), shared = sharedRepositoryBarePath(repositoryId);
    const ref = `refs/heads/${sessionBranchOf(roomId)}`;
    const ours = (await git(bare, ["rev-parse", ref])).trim();
    const sourceBytes = await repositoryStorageBytes(`shared:${repositoryId}`);
    await requireStorageGrowth(sourceBytes * 3 + 32 * 1024 * 1024, roomId);
    if (publish) await requireStorageGrowth((await repositoryStorageBytes(roomId)) * 2 + sourceBytes + 32 * 1024 * 1024);
    await git(bare, ["fetch", "--no-tags", shared, `refs/heads/${BASE_BRANCH}`]);
    const theirs = (await git(bare, ["rev-parse", "FETCH_HEAD"])).trim();
    const outcome = await mergeObjects(bare, ours, theirs);
    if (!outcome.ok) return outcome;
    if (publish) await git(bare, ["push", shared, `${outcome.sha}:refs/heads/${BASE_BRANCH}`]);
    await git(bare, ["update-ref", ref, outcome.sha, ours]);
    return outcome;
  }));
}
async function stored_publishRoom(roomId: string, repositoryId: string): Promise<MergeResult> {
  return mergeShared(roomId, repositoryId, true);
}
async function stored_syncRoom(roomId: string, repositoryId: string): Promise<MergeResult> {
  return mergeShared(roomId, repositoryId, false);
}

/** The current `main` of a shared repository's canonical repo, or null if uninitialised. */
async function stored_sharedRepositoryHeadSha(repositoryId: string): Promise<string | null> {
  const bare = sharedRepositoryBarePath(repositoryId);
  if (!(await exists(bare))) return null;
  try {
    return (await git(bare, ["rev-parse", BASE_BRANCH])).trim();
  } catch {
    return null;
  }
}

function contextBare(ref: string): string {
  if (!isSessionId(ref) && !/^[0-9a-f-]{36}$/i.test(ref)) throw new Error("Invalid repository ref");
  return isSessionId(ref) ? barePath(ref) : sharedRepositoryBarePath(ref);
}

function commitSha(sha: string): string {
  if (!/^[0-9a-f]{40,64}$/i.test(sha)) throw new Error("Invalid commit SHA");
  return sha;
}

/** Exact ancestry proof used by memory publication/recovery. A Git failure
 * must retry; it must never be mistaken for successful publication. */
async function stored_repoContainsCommit(ref: string, ancestor: string, head: string): Promise<boolean> {
  try {
    await git(contextBare(ref), ["merge-base", "--is-ancestor", commitSha(ancestor), commitSha(head)]);
    return true;
  } catch (cause) {
    if ((cause as { code?: number }).code === 1) return false;
    throw cause;
  }
}

/** Immutable, NUL-delimited snapshot reads for indexing. Errors must retry,
 * never masquerade as an empty repository and erase the previous index. */
async function stored_repoSnapshotPaths(ref: string, sha: string): Promise<string[]> {
  const tree = await git(contextBare(ref), ["ls-tree", "-rz", commitSha(sha)]);
  return tree.split("\0").filter(Boolean).flatMap((entry) => {
    const tab = entry.indexOf("\t");
    const metadata = entry.slice(0, tab);
    return /^100(?:644|755) blob /.test(metadata) ? [entry.slice(tab + 1)] : [];
  });
}

async function stored_repoSnapshotDiff(ref: string, from: string, to: string): Promise<string[]> {
  const diff = await git(contextBare(ref), ["diff", "--no-renames", "--name-only", "-z", commitSha(from), commitSha(to), "--"]);
  return diff.split("\0").filter(Boolean);
}

/** Skip oversized/binary files explicitly; never silently truncate source. */
async function stored_repoSnapshotText(ref: string, sha: string, path: string): Promise<string | null> {
  if (!path || path.includes("\0")) throw new Error("Invalid snapshot path");
  const object = `${commitSha(sha)}:${path}`;
  const bare = contextBare(ref);
  const size = Number((await git(bare, ["cat-file", "-s", object])).trim());
  if (size > MAX_TEXT_BYTES) return null;
  const text = await git(bare, ["cat-file", "blob", object]);
  return text.includes("\0") ? null : text;
}

/**
 * Verify a commit a runner claims to have produced: it must exist in the bare
 * repo and extend the base the run started from. This is what stops a
 * completion report from pointing the head at history that was never pushed
 * through the guarded smart-HTTP endpoint (or at someone else's commit).
 */
async function stored_verifyPushedCommit(
  repoRef: string,
  baseSha: string,
  sha: string,
): Promise<boolean> {
  const bare = barePath(repoRef);
  if (!(await exists(bare))) return false;
  if (!/^[0-9a-f]{40}$/i.test(sha)) return false;
  const inRepo = await gitOk(bare, ["cat-file", "-e", `${sha}^{commit}`]);
  if (!inRepo) return false;
  return gitOk(bare, ["merge-base", "--is-ancestor", baseSha, sha]);
}

/**
 * Every tracked path at the shared repository's `main` HEAD, read straight from the bare
 * repo — no working copy needed, so this is safe from any process. Used by the
 * repo-context indexer (app/lib/knowledge/repo-context.ts).
 */
async function stored_listSharedRepositoryFiles(repositoryId: string): Promise<string[]> {
  const bare = sharedRepositoryBarePath(repositoryId);
  if (!(await exists(bare))) return [];
  try {
    const out = await git(bare, ["ls-tree", "-r", "--name-only", BASE_BRANCH]);
    return out.split("\n").map((line) => line.trim()).filter(Boolean);
  } catch {
    return [];
  }
}

/*
 * The same three reads for a *room's* repo — its fork, or an imported one —
 * whose bare lives at `repos/<id>.git` and whose work happens on
 * `session/<id>`. These exist so the context indexer can understand the repo
 * a chat actually edits, not just the shared repository's canonical main.
 */

/** The head of a room repo's working branch, straight from its bare repo. */
async function stored_repoRefHeadSha(id: string): Promise<string | null> {
  const bare = barePath(id);
  if (!(await exists(bare))) return null;
  try {
    return (await git(bare, ["rev-parse", sessionBranchOf(id)])).trim();
  } catch {
    return null;
  }
}

/** Every tracked path at a room repo's working-branch head. */
async function stored_listRepoRefFiles(id: string): Promise<string[]> {
  const bare = barePath(id);
  if (!(await exists(bare))) return [];
  try {
    const out = await git(bare, ["ls-tree", "-r", "--name-only", sessionBranchOf(id)]);
    return out.split("\n").map((line) => line.trim()).filter(Boolean);
  } catch {
    return [];
  }
}

/** One file's text at a room repo's working-branch head; caps like the project variant. */
async function stored_readRepoRefFileText(
  id: string,
  relative: string,
  maxBytes = 64 * 1024,
): Promise<string | null> {
  const path = safeRelativePath(relative);
  if (!path) return null;
  const bare = barePath(id);
  if (!(await exists(bare))) return null;
  try {
    const out = await git(bare, ["show", `${sessionBranchOf(id)}:${path}`]);
    if (out.includes("\0")) return null;
    return out.length > maxBytes ? out.slice(0, maxBytes) : out;
  } catch {
    return null;
  }
}

/**
 * One file's text at the shared repository's `main` HEAD, or null when it is missing,
 * binary, or the path is unsafe. Truncated to `maxBytes` — the callers distill
 * summaries, so a file's head is all they need.
 */
async function stored_readSharedRepositoryFileText(
  repositoryId: string,
  relative: string,
  maxBytes = 64 * 1024,
): Promise<string | null> {
  const path = safeRelativePath(relative);
  if (!path) return null;
  const bare = sharedRepositoryBarePath(repositoryId);
  if (!(await exists(bare))) return null;
  try {
    const out = await git(bare, ["show", `${BASE_BRANCH}:${path}`]);
    if (out.includes("\0")) return null;
    return out.length > maxBytes ? out.slice(0, maxBytes) : out;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Seeding
// ---------------------------------------------------------------------------

export type SeedOutcome = { written: number; skipped: string[] };

/** Writes uploaded blobs into a private import index; no extracted project folder. */
async function stored_writeSeedBatch(
  id: string,
  files: { path: string; data: string }[],
): Promise<SeedOutcome> {
  const estimatedBytes = files.reduce((sum, file) => {
    const relative = safeRelativePath(file.path), bytes = Buffer.byteLength(file.data, "base64");
    if (!relative || bytes > MAX_SEED_FILE_BYTES || /(^|\/)(node_modules|\.next|\.env(?:\.(?:local|development|production|test)(?:\.local)?)?)(\/|$)/.test(relative)) return sum;
    return sum + bytes + Buffer.byteLength(relative) * 4 + 512;
  }, 0);
  await requireStorageGrowth(estimatedBytes * 2 + 2 * 1024 * 1024);
  const bare = barePath(id);
  const index = { GIT_INDEX_FILE: join(bare, "import.index") };
  if (!await exists(index.GIT_INDEX_FILE)) await objectGit(bare, ["read-tree", "--empty"], undefined, index);
  const skipped: string[] = [];
  let written = 0;
  let batch: { path: string; bytes: Buffer }[] = [];
  let batchBytes = 0;
  const flush = async () => {
    await putBlobs(bare, index, batch);
    written += batch.length;
    batch = [];
    batchBytes = 0;
  };
  for (const file of files) {
    const relative = safeRelativePath(file.path);
    if (!relative || /(^|\/)(node_modules|\.next|\.env(?:\.(?:local|development|production|test)(?:\.local)?)?)(\/|$)/.test(relative)) { skipped.push(String(file.path)); continue; }
    const bytes = Buffer.from(file.data, "base64");
    if (bytes.length > MAX_SEED_FILE_BYTES) { skipped.push(relative); continue; }
    if (batchBytes + bytes.length > MAX_SEED_FILE_BYTES || batch.length >= 200) await flush();
    batch.push({ path: relative, bytes });
    batchBytes += bytes.length;
  }
  await flush();

  return { written, skipped };
}

/**
 * Commits the seeded tree onto the base branch, then forks the session branch
 * from it. Base and session start level, so drift begins at zero and is always
 * measured against a real commit.
 */
async function stored_finishSeed(id: string, rootName: string): Promise<SessionRepo> {
  const bare = barePath(id), branch = sessionBranchOf(id);
  const index = { GIT_INDEX_FILE: join(bare, "import.index") };
  if (!await exists(index.GIT_INDEX_FILE)) await objectGit(bare, ["read-tree", "--empty"], undefined, index);
  await filterImportIndex(bare, index);
  const tree = await objectText(bare, ["write-tree"], undefined, index);
  const baseSha = await commitTree(bare, tree, [], "Seed session");
  await git(bare, ["update-ref", `refs/heads/${BASE_BRANCH}`, baseSha]);
  await git(bare, ["update-ref", `refs/heads/${branch}`, baseSha]);
  await rm(index.GIT_INDEX_FILE, { force: true });
  return {
    rootName,
    baseBranch: BASE_BRANCH,
    baseShaAtFork: baseSha,
    sessionBranch: branch,
    headSha: baseSha,
    depLockfileHash: await lockfileHash(id),
    specDocSha: await specDocSha(id),
    containerImageDigest: null,
    lastTestStatus: "unknown",
    lastTestSha: null,
    seededAt: Date.now(),
  };
}

const LOCKFILES = [
  "package-lock.json",
  "pnpm-lock.yaml",
  "yarn.lock",
  "bun.lock",
  "bun.lockb",
  "Cargo.lock",
  "go.sum",
  "Gemfile.lock",
  "composer.lock",
  "poetry.lock",
  "uv.lock",
  "requirements.txt",
];

/** Hashes every lockfile present, so an unchanged toolchain is a cache hit. */
async function lockfileHash(id: string): Promise<string | null> {
  const work = workPath(id);
  const hash = createHash("sha256");
  let found = false;

  for (const name of LOCKFILES) {
    const absolute = resolveInside(work, name);
    if (!absolute) continue;
    try {
      const bytes = await readCommittedBytes(id, await headSha(id), name);
      if (!bytes) continue;
      hash.update(name);
      hash.update(bytes);
      found = true;
    } catch {
      // Absent, which is the common case.
    }
  }

  return found ? hash.digest("hex") : null;
}

const SPEC_DOCS = ["AGENTS.md", "CLAUDE.md"];

/**
 * The blob sha git already computed for the spec doc. Note this tracks the file
 * verbatim: a generated block inside it (as `next dev` writes) will churn the
 * value on every regeneration.
 */
async function specDocSha(id: string): Promise<string | null> {
  for (const name of SPEC_DOCS) {
    try {
      const sha = (await git(barePath(id), ["rev-parse", `${await headSha(id)}:${name}`])).trim();
      if (sha) return sha;
    } catch {
      // Not tracked at this commit.
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

/**
 * Lists the tree at HEAD. Read from git rather than from disk so the listing is
 * always a committed state — untracked scratch files never leak into it.
 */
async function stored_listTree(id: string, rootName: string): Promise<TreeNode> {
  return listCommittedTree(id, rootName, await headSha(id));
}

/**
 * Files that differ between the seed commit and HEAD — everything the session's
 * people and agents have changed. Rename/copy lines carry two paths; the new
 * one is what the explorer opens.
 */
/** Added/removed line totals between two commits, for a run's diff badge. */
async function stored_diffStat(
  id: string,
  base: string,
  head: string,
): Promise<{ added: number; removed: number }> {
  const work = workPath(id);
  const stdout = await git(work, ["diff", "--numstat", base, head]).catch(() => "");
  return countNumstat(stdout);
}

/**
 * Line counts straight from the bare repo — no working copy needed. This is
 * the one a *finished* run must use: a locally-executed run pushed its commit
 * to the bare repo, but the server's working copy (if any) hasn't fetched it,
 * so diffing there would silently report nothing changed.
 */
async function stored_diffStatBare(
  id: string,
  base: string,
  head: string,
): Promise<{ added: number; removed: number }> {
  const stdout = await git(barePath(id), ["diff", "--numstat", base, head]).catch(() => "");
  return countNumstat(stdout);
}

/** One file's line delta between two commits. */
export type FileChange = { path: string; added: number; removed: number };

/**
 * Per-file line deltas straight from the bare repo — what the chat shows as
 * "which files changed, and by how much" when a run finishes. Same source of
 * truth as diffStatBare, just not collapsed to totals. Binary files report
 * no line counts and come back as 0/0 rather than being dropped, so a run
 * that only touched an image still names the file.
 */
async function stored_diffFilesBare(id: string, base: string, head: string): Promise<FileChange[]> {
  const stdout = await git(barePath(id), ["diff", "--numstat", base, head]).catch(() => "");
  const files: FileChange[] = [];
  for (const line of stdout.split("\n")) {
    if (!line.trim()) continue;
    const [a, r, ...rest] = line.split("\t");
    const path = rest.join("\t");
    if (!path) continue;
    files.push({
      path,
      added: a && a !== "-" ? Number(a) || 0 : 0,
      removed: r && r !== "-" ? Number(r) || 0 : 0,
    });
  }
  return files;
}

function countNumstat(stdout: string): { added: number; removed: number } {
  let added = 0;
  let removed = 0;
  for (const line of stdout.split("\n")) {
    if (!line.trim()) continue;
    const [a, r] = line.split("\t");
    // Binary files report "-\t-"; only count numeric rows.
    if (a && a !== "-") added += Number(a) || 0;
    if (r && r !== "-") removed += Number(r) || 0;
  }
  return { added, removed };
}

async function stored_listChangedFiles(id: string, baseSha: string): Promise<ChangedFile[]> {
  const work = workPath(id);
  const stdout = await git(work, ["diff", "--name-status", "-M", baseSha, "HEAD"]).catch(() => "");

  const changes: ChangedFile[] = [];
  for (const line of stdout.split("\n")) {
    if (!line.trim()) continue;
    const fields = line.split("\t");
    const letter = (fields[0]?.[0] ?? "M").toUpperCase();
    const status = (["A", "M", "D", "R", "C"].includes(letter) ? letter : "M") as ChangedFile["status"];
    // Renames/copies are "R100\told\tnew"; plain changes are "M\tpath".
    const path = fields.length >= 3 ? fields[fields.length - 1] : fields[1];
    if (path) changes.push({ path, status });
  }
  return changes;
}



export type RepoFile = {
  text: string;
  size: number;
  truncated: boolean;
  binary: boolean;
};

/**
 * Reads from the working copy rather than from git: the "never uncommitted"
 * invariant makes them equal, and this way a read costs no process spawn.
 */
async function stored_readRepoFile(id: string, relative: string): Promise<RepoFile | null> {
  const absolute = await safeWorkFile(id, relative);
  if (!absolute) return null;

  let bytes: Buffer;
  try {
    bytes = await readFile(absolute);
  } catch {
    return null;
  }

  // A NUL byte in the first block is the usual "this is not text" signal.
  if (bytes.subarray(0, 4096).includes(0)) {
    return { text: "", size: bytes.byteLength, truncated: false, binary: true };
  }

  const truncated = bytes.byteLength > MAX_TEXT_BYTES;
  return {
    text: (truncated ? bytes.subarray(0, MAX_TEXT_BYTES) : bytes).toString("utf8"),
    size: bytes.byteLength,
    truncated,
    binary: false,
  };
}

async function stored_readRepoBytes(id: string, relative: string): Promise<Buffer | null> {
  const absolute = await safeWorkFile(id, relative);
  if (!absolute) return null;
  try {
    return await readFile(absolute);
  } catch {
    return null;
  }
}

async function stored_headSha(id: string): Promise<string> {
  return (await git(barePath(id), ["rev-parse", `refs/heads/${sessionBranchOf(id)}`])).trim();
}

// ---------------------------------------------------------------------------
// Writing
// ---------------------------------------------------------------------------

async function stored_writeRepoFile(id: string, relative: string, text: string): Promise<boolean> {
  const absolute = await safeWorkFile(id, relative);
  if (!absolute) return false;

  await mkdir(dirname(absolute), { recursive: true });
  await writeFile(absolute, text, "utf8");
  return true;
}

export type SaveResult =
  | { status: "clean"; headSha: string }
  | { status: "nochange"; headSha: string }
  /** Overlapping edits: nothing was committed; the room is unchanged. */
  | { status: "conflict"; headSha: string };

/** Runs git's standalone 3-way merge, returning the conflict count (0 = clean). */
async function mergeFile(ours: string, base: string, theirs: string): Promise<number> {
  try {
    // Merges `theirs` into `ours` using `base` as the ancestor, in place in `ours`.
    await objectGit(dirname(ours), ["merge-file", "-L", "current", "-L", "base", "-L", "incoming", ours, base, theirs]);
    return 0;
  } catch (cause) {
    const code = (cause as { code?: unknown }).code;
    return typeof code === "number" ? code : -1;
  }
}

/**
 * Saves a file the safe way: a 3-way merge against the version the editor was
 * working from, instead of a blind overwrite.
 *
 * `baseText` is what the client had before it started editing. If nobody else
 * has touched the file since, this is a plain write. If someone has, git merges
 * the two sets of changes: non-overlapping edits both survive, and only genuine
 * line-level collisions are reported as a conflict — which commits nothing, so a
 * concurrent edit can never be silently lost.
 */
async function stored_mergeSave(
  id: string,
  relative: string,
  baseText: string,
  incomingText: string,
  headAtRequest: string,
  author: { name: string; email: string },
  onCommitted?: (sha: string) => Promise<void>,
): Promise<SaveResult> {
  const bare = barePath(id);
  return withRepoLock(id, async () => {
    const canonical = await headSha(id);
    const clean = safeRelativePath(relative);
    if (!clean) throw new Error("Unsafe path.");
    const entry = await git(bare, ["ls-tree", "-z", canonical, "--", clean]);
    if (entry && !entry.startsWith("100")) throw new Error("Unsafe path or symbolic link.");
    // Reject a path beneath an existing file/symlink rather than replacing it.
    const parts = clean.split("/");
    for (let i = 1; i < parts.length; i++) {
      const parent = await git(bare, ["ls-tree", "-z", canonical, "--", parts.slice(0, i).join("/")]);
      if (parent && !parent.startsWith("040000")) throw new Error("Unsafe parent path.");
    }
    const ours = (await readCommittedBytes(id, canonical, clean))?.toString("utf8") ?? "";
    if (ours === incomingText) return { status: "nochange", headSha: canonical };
    let text = incomingText;
    if (ours !== baseText) {
      const scratch = join(bare, `.merge-${randomBytes(6).toString("hex")}`);
      await mkdir(scratch);
      try {
        const a = join(scratch, "ours"), b = join(scratch, "base"), c = join(scratch, "theirs");
        await Promise.all([writeFile(a, ours), writeFile(b, baseText), writeFile(c, incomingText)]);
        if (await mergeFile(a, b, c) !== 0) return { status: "conflict", headSha: canonical };
        text = await readFile(a, "utf8");
      } finally { await rm(scratch, { recursive: true, force: true }); }
    }
    const sha = await withTemporaryIndex(bare, async env => {
      await objectGit(bare, ["read-tree", canonical], undefined, env);
      await putBlob(bare, env, clean, text, entry.startsWith("100755") ? "100755" : "100644");
      return commitTree(bare, await objectText(bare, ["write-tree"], undefined, env), [canonical], `WIP: ${clean}`, author);
    });
    await git(bare, ["update-ref", `refs/heads/${sessionBranchOf(id)}`, sha, canonical]);
    await onCommitted?.(sha);
    return { status: "clean", headSha: sha };
  });
}

/**
 * Commits whatever is dirty and pushes it. Returns null when the tree was
 * already clean, so a redundant save does not manufacture an empty commit.
 */
async function stored_commitWork(
  id: string,
  message: string,
  authorName?: string,
  authorEmail?: string,
): Promise<string | null> {
  const work = workPath(id);

  await git(work, ["add", "-A"]);
  const status = (await git(work, ["status", "--porcelain"])).trim();
  if (status.length === 0) return null;

  // Attribute the commit to whoever made the edit. `git log` is the audit trail
  // for a session, and "multiplayer-ai" on every commit would waste it.
  const author =
    authorName && authorEmail
      ? ["-c", `user.name=${authorName}`, "-c", `user.email=${authorEmail}`]
      : [];

  await git(work, [...author, "commit", "-m", message]);
  const sha = (await git(work, ["rev-parse", "HEAD"])).trim();

  // A failed push must not lose the commit: it is safe locally, and the next
  // save will carry it. Surfacing it as an error would be worse.
  await git(work, ["push", "origin", sessionBranchOf(id)]);
  return sha;
}

/** Restores the working copy to a session's recorded HEAD. */
async function stored_checkoutHead(id: string, sha: string): Promise<void> {
  const work = workPath(id);
  await git(work, ["checkout", "--force", sessionBranchOf(id)]);
  await git(work, ["reset", "--hard", sha]);
}

/**
 * Rebuilds the working copy from the bare repo when it is missing or damaged.
 *
 * This is what makes the "the sandbox is a cache" claim true rather than
 * aspirational: `<root>/work` can be deleted wholesale and every session still
 * resumes, because the bare repo is the only thing that was ever the record.
 */
async function stored_ensureWork(id: string, sha: string): Promise<void> {
  const work = workPath(id);
  const branch = sessionBranchOf(id);

  if (await isWorkTree(work)) {
    await git(work, ["fetch", "origin", branch]);
    const current = (await git(work, ["rev-parse", "HEAD"])).trim();
    if (current === sha) return;
    if ((await git(work, ["status", "--porcelain"])).trim() || !await gitOk(work, ["merge-base", "--is-ancestor", current, sha])) {
      throw new Error("This checkout has unsaved changes or undelivered commits. They were preserved for recovery.");
    }
    await checkoutHead(id, sha);
    return;
  }

  await rm(work, { recursive: true, force: true });
  await mkdir(dirname(work), { recursive: true });
  await git(dirname(work), ["clone", "--branch", branch, barePath(id), work]);
  await git(work, ["reset", "--hard", sha]);
}

async function isWorkTree(work: string): Promise<boolean> {
  try {
    return (await stat(join(work, ".git"))).isDirectory();
  } catch {
    return false;
  }
}

async function stored_prepareTurnWork(repoRef: string, turnId: string, baseSha: string): Promise<string> {
  const work = workPath(`turn-${turnId}`);
  await mkdir(dirname(work), { recursive: true });
  await git(dirname(work), ["clone", "--no-checkout", barePath(repoRef), work]);
  await git(work, ["checkout", "--detach", baseSha]);
  return work;
}

async function stored_commitTurnWork(repoRef: string, turnId: string, baseSha: string, author: { name: string; email: string }): Promise<string | null> {
  const work = workPath(`turn-${turnId}`);
  await git(work, ["add", "-A"]);
  if ((await git(work, ["status", "--porcelain"])).trim()) {
    await git(work, ["-c", `user.name=${author.name}`, "-c", `user.email=${author.email}`, "commit", "-m", "Agent turn"]);
  }
  const sha = (await git(work, ["rev-parse", "HEAD"])).trim();
  if (sha === baseSha) { await rm(work, { recursive: true, force: true }); return null; }
  await git(work, ["push", "origin", `HEAD:refs/turns/${turnId}`]);
  await rm(work, { recursive: true, force: true });
  return sha;
}

async function stored_promoteTurn(repoRef: string, turnId: string, baseSha: string, sha: string): Promise<void> {
  const bare = barePath(repoRef);
  const candidate = (await git(bare, ["rev-parse", `refs/turns/${turnId}`])).trim();
  if (candidate !== sha || !await verifyPushedCommit(repoRef, baseSha, sha)) throw new Error("The turn's candidate commit could not be verified.");
  const ref = `refs/heads/${sessionBranchOf(repoRef)}`;
  const current = (await git(bare, ["rev-parse", ref])).trim();
  if (current === sha) return;
  if (current !== baseSha) throw new Error("Repository changed during execution. Your result is preserved on its turn ref; review it before merging.");
  await git(bare, ["update-ref", ref, sha, baseSha]);
}

async function safeWorkFile(id: string, relative: string): Promise<string | null> {
  const clean = safeRelativePath(relative);
  if (!clean) return null;
  let current = workPath(id);
  for (const segment of clean.split("/")) {
    current = join(current, segment);
    const entry = await lstat(current).catch((cause: NodeJS.ErrnoException) => {
      if (cause.code === "ENOENT") return null;
      throw cause;
    });
    if (entry?.isSymbolicLink()) return null;
  }
  return current;
}

async function stored_listCommittedTree(id: string, rootName: string, sha: string): Promise<TreeNode> {
  const bare = barePath(id);
  const output = (await cachedGitRead(bare, sha, "tree", async () =>
    Buffer.from(await git(bare, ["ls-tree", "-rzl", "--full-tree", sha]))))!.toString("utf8");
  const entries: TreeEntry[] = [];
  for (const record of output.split("\0")) {
    const tab = record.indexOf("\t");
    if (tab < 0) continue;
    const fields = record.slice(0, tab).trim().split(/\s+/);
    if (fields[1] === "blob") entries.push({ path: record.slice(tab + 1), size: Number(fields[3]) || 0 });
  }
  return buildTree(rootName, entries);
}

async function stored_readCommittedBytes(id: string, sha: string, relative: string): Promise<Buffer | null> {
  if (!safeRelativePath(relative)) return null;
  const bare = barePath(id);
  return cachedGitRead(bare, sha, `file:${relative}`, async () => {
  const entry = await git(bare, ["ls-tree", "-z", sha, "--", relative]);
  if (!entry.startsWith("100") || entry.split("\t")[1]?.replace(/\0$/, "") !== relative) return null;
  const object = `${sha}:${relative}`;
  const size = Number((await git(bare, ["cat-file", "-s", object])).trim());
  if (size > MAX_SEED_FILE_BYTES) throw new Error("This file exceeds the 8 MB read limit.");
  return objectGit(bare, ["cat-file", "blob", object], undefined, {}, MAX_SEED_FILE_BYTES + 1024);
  });
}

async function stored_committedChanges(id: string, base: string, head: string): Promise<ChangedFile[]> {
  const output = await git(barePath(id), ["diff", "--name-status", "--no-renames", "-z", base, head]);
  const fields = output.split("\0");
  const changes: ChangedFile[] = [];
  for (let index = 0; index + 1 < fields.length; index += 2) {
    changes.push({ status: fields[index] as ChangedFile["status"], path: fields[index + 1] });
  }
  return changes;
}

/** First explicit publication of a room-only repository. No project-wide repo is inferred. */
async function stored_initializeSharedRepository(ref: string, repositoryId: string, sha: string): Promise<void> {
  const bare = sharedRepositoryBarePath(repositoryId);
  if (await sharedRepositoryHeadSha(repositoryId)) return;
  await mkdir(dirname(bare), { recursive: true });
  if (!await exists(bare)) await git(dirname(bare), ["init", "--bare", "-b", BASE_BRANCH, bare]);
  await requireStorageGrowth((await repositoryStorageBytes(ref)) * 2 + 2 * 1024 * 1024);
  await git(bare, ["fetch", barePath(ref), `${sha}:refs/heads/${BASE_BRANCH}`]);
}

export const createRepo = (...args: Parameters<typeof stored_createRepo>): ReturnType<typeof stored_createRepo> => withStoredRepo(barePath(args[0]), () => withRepoLock(args[0], () => stored_createRepo(...args)));

export const writeSeedBatch = (...args: Parameters<typeof stored_writeSeedBatch>): ReturnType<typeof stored_writeSeedBatch> => withStoredRepo(barePath(args[0]), () => withRepoLock(args[0], () => stored_writeSeedBatch(...args)));

export const finishSeed = (...args: Parameters<typeof stored_finishSeed>): ReturnType<typeof stored_finishSeed> => withStoredRepo(barePath(args[0]), () => withRepoLock(args[0], () => stored_finishSeed(...args)));

export const verifyPushedCommit = (...args: Parameters<typeof stored_verifyPushedCommit>): ReturnType<typeof stored_verifyPushedCommit> => withStoredRepo(barePath(args[0]), () => stored_verifyPushedCommit(...args));

export const repoRefHeadSha = (...args: Parameters<typeof stored_repoRefHeadSha>): ReturnType<typeof stored_repoRefHeadSha> => withStoredRepo(barePath(args[0]), () => stored_repoRefHeadSha(...args));

export const listRepoRefFiles = (...args: Parameters<typeof stored_listRepoRefFiles>): ReturnType<typeof stored_listRepoRefFiles> => withStoredRepo(barePath(args[0]), () => stored_listRepoRefFiles(...args));

export const readRepoRefFileText = (...args: Parameters<typeof stored_readRepoRefFileText>): ReturnType<typeof stored_readRepoRefFileText> => withStoredRepo(barePath(args[0]), () => stored_readRepoRefFileText(...args));

export const listTree = (...args: Parameters<typeof stored_listTree>): ReturnType<typeof stored_listTree> => withStoredRepo(barePath(args[0]), () => stored_listTree(...args));

export const diffStat = (...args: Parameters<typeof stored_diffStat>): ReturnType<typeof stored_diffStat> => withStoredRepo(barePath(args[0]), () => stored_diffStat(...args));

export const diffStatBare = (...args: Parameters<typeof stored_diffStatBare>): ReturnType<typeof stored_diffStatBare> => withStoredRepo(barePath(args[0]), () => stored_diffStatBare(...args));

export const diffFilesBare = (...args: Parameters<typeof stored_diffFilesBare>): ReturnType<typeof stored_diffFilesBare> => withStoredRepo(barePath(args[0]), () => stored_diffFilesBare(...args));

export const listChangedFiles = (...args: Parameters<typeof stored_listChangedFiles>): ReturnType<typeof stored_listChangedFiles> => withStoredRepo(barePath(args[0]), () => stored_listChangedFiles(...args));

export const readRepoFile = (...args: Parameters<typeof stored_readRepoFile>): ReturnType<typeof stored_readRepoFile> => withStoredRepo(barePath(args[0]), () => stored_readRepoFile(...args));

export const readRepoBytes = (...args: Parameters<typeof stored_readRepoBytes>): ReturnType<typeof stored_readRepoBytes> => withStoredRepo(barePath(args[0]), () => stored_readRepoBytes(...args));

export const headSha = (...args: Parameters<typeof stored_headSha>): ReturnType<typeof stored_headSha> => withStoredRepo(barePath(args[0]), () => stored_headSha(...args));

export const writeRepoFile = (...args: Parameters<typeof stored_writeRepoFile>): ReturnType<typeof stored_writeRepoFile> => withStoredRepo(barePath(args[0]), () => withRepoLock(args[0], () => stored_writeRepoFile(...args)));

export const mergeSave = (...args: Parameters<typeof stored_mergeSave>): ReturnType<typeof stored_mergeSave> => withStoredRepo(barePath(args[0]), () => withRepoLock(args[0], () => stored_mergeSave(...args)));

export const commitWork = (...args: Parameters<typeof stored_commitWork>): ReturnType<typeof stored_commitWork> => withStoredRepo(barePath(args[0]), () => withRepoLock(args[0], () => stored_commitWork(...args)));

export const checkoutHead = (...args: Parameters<typeof stored_checkoutHead>): ReturnType<typeof stored_checkoutHead> => withStoredRepo(barePath(args[0]), () => withRepoLock(args[0], () => stored_checkoutHead(...args)));

export const ensureWork = (...args: Parameters<typeof stored_ensureWork>): ReturnType<typeof stored_ensureWork> => withStoredRepo(barePath(args[0]), () => withRepoLock(args[0], () => stored_ensureWork(...args)));

export const prepareTurnWork = (...args: Parameters<typeof stored_prepareTurnWork>): ReturnType<typeof stored_prepareTurnWork> => withStoredRepo(barePath(args[0]), () => withRepoLock(args[0], () => stored_prepareTurnWork(...args)));

export const commitTurnWork = (...args: Parameters<typeof stored_commitTurnWork>): ReturnType<typeof stored_commitTurnWork> => withStoredRepo(barePath(args[0]), () => withRepoLock(args[0], () => stored_commitTurnWork(...args)));

export const promoteTurn = (...args: Parameters<typeof stored_promoteTurn>): ReturnType<typeof stored_promoteTurn> => withStoredRepo(barePath(args[0]), () => withRepoLock(args[0], () => stored_promoteTurn(...args)));

export const listCommittedTree = (...args: Parameters<typeof stored_listCommittedTree>): ReturnType<typeof stored_listCommittedTree> => withStoredRepo(barePath(args[0]), () => stored_listCommittedTree(...args));

export const readCommittedBytes = (...args: Parameters<typeof stored_readCommittedBytes>): ReturnType<typeof stored_readCommittedBytes> => withStoredRepo(barePath(args[0]), () => stored_readCommittedBytes(...args));

export const committedChanges = (...args: Parameters<typeof stored_committedChanges>): ReturnType<typeof stored_committedChanges> => withStoredRepo(barePath(args[0]), () => stored_committedChanges(...args));

export const ensureSharedRepository = (...args: Parameters<typeof stored_ensureSharedRepository>): ReturnType<typeof stored_ensureSharedRepository> => withStoredRepo(sharedRepositoryBarePath(args[0]), () => withRepoLock(`shared:${args[0]}`, () => stored_ensureSharedRepository(...args)));

export const sharedRepositoryHeadSha = (...args: Parameters<typeof stored_sharedRepositoryHeadSha>): ReturnType<typeof stored_sharedRepositoryHeadSha> => withStoredRepo(sharedRepositoryBarePath(args[0]), () => stored_sharedRepositoryHeadSha(...args));

export const listSharedRepositoryFiles = (...args: Parameters<typeof stored_listSharedRepositoryFiles>): ReturnType<typeof stored_listSharedRepositoryFiles> => withStoredRepo(sharedRepositoryBarePath(args[0]), () => stored_listSharedRepositoryFiles(...args));

export const readSharedRepositoryFileText = (...args: Parameters<typeof stored_readSharedRepositoryFileText>): ReturnType<typeof stored_readSharedRepositoryFileText> => withStoredRepo(sharedRepositoryBarePath(args[0]), () => stored_readSharedRepositoryFileText(...args));

export const repoContainsCommit = (...args: Parameters<typeof stored_repoContainsCommit>): ReturnType<typeof stored_repoContainsCommit> => withStoredRepo(contextBare(args[0]), () => stored_repoContainsCommit(...args));

export const repoSnapshotPaths = (...args: Parameters<typeof stored_repoSnapshotPaths>): ReturnType<typeof stored_repoSnapshotPaths> => withStoredRepo(contextBare(args[0]), () => stored_repoSnapshotPaths(...args));

export const repoSnapshotDiff = (...args: Parameters<typeof stored_repoSnapshotDiff>): ReturnType<typeof stored_repoSnapshotDiff> => withStoredRepo(contextBare(args[0]), () => stored_repoSnapshotDiff(...args));

export const repoSnapshotText = (...args: Parameters<typeof stored_repoSnapshotText>): ReturnType<typeof stored_repoSnapshotText> => withStoredRepo(contextBare(args[0]), () => stored_repoSnapshotText(...args));

export const forkRoomRepository = (...args: Parameters<typeof stored_forkRoomRepository>): ReturnType<typeof stored_forkRoomRepository> => withStoredRepo(barePath(args[0]), () => withStoredRepo(sharedRepositoryBarePath(args[1]), () => withRepoLock(args[0], () => withRepoLock(`shared:${args[1]}`, () => stored_forkRoomRepository(...args)))));

export const publishRoom = (...args: Parameters<typeof stored_publishRoom>): ReturnType<typeof stored_publishRoom> => withStoredRepo(barePath(args[0]), () => withStoredRepo(sharedRepositoryBarePath(args[1]), () => stored_publishRoom(...args)));

export const syncRoom = (...args: Parameters<typeof stored_syncRoom>): ReturnType<typeof stored_syncRoom> => withStoredRepo(barePath(args[0]), () => withStoredRepo(sharedRepositoryBarePath(args[1]), () => stored_syncRoom(...args)));

export const initializeSharedRepository = (...args: Parameters<typeof stored_initializeSharedRepository>): ReturnType<typeof stored_initializeSharedRepository> => withStoredRepo(barePath(args[0]), () => withStoredRepo(sharedRepositoryBarePath(args[1]), () => withRepoLock(args[0], () => withRepoLock(`shared:${args[1]}`, () => stored_initializeSharedRepository(...args)))));
