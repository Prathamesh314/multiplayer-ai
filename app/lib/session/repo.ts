import { execFile } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { buildTree, type TreeEntry } from "../tree";
import type { TreeNode } from "../types";
import { repoLock } from "./lock";
import { barePath, projectBarePath, resolveInside, safeRelativePath, workPath } from "./paths";
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

/**
 * Git serialises on `index.lock`, so two concurrent commits in the same working
 * copy make one of them fail. Queue per session instead of letting them race.
 *
 * The queueing lives in `app/lib/session/lock.ts` now, because the racers are no
 * longer always in one process: once agent runs move to a worker, a human's
 * file-save (web process) and the agent's commit (worker process) contend for
 * the same `index.lock`, and only a cross-process lock can see both. `repoLock`
 * is that arbiter — Redis-backed when `REDIS_URL` is set, and the same
 * in-process mutex this used to be otherwise. Every working-copy git op in this
 * module routes through here, so they all serialise on one lock.
 */
export async function withRepoLock<T>(id: string, task: () => Promise<T>): Promise<T> {
  const lock = await repoLock();
  return lock.withLock(id, task);
}

/**
 * Config is pinned per invocation rather than read from the machine: a session
 * repo must behave identically wherever the server happens to run.
 */
const CONFIG = [
  "-c", "user.name=multiplayer-ai",
  "-c", "user.email=sessions@multiplayer-ai.local",
  "-c", "commit.gpgsign=false",
  "-c", "core.autocrlf=false",
  // Keeps non-ASCII paths readable in ls-tree output instead of \NNN escapes.
  "-c", "core.quotePath=false",
];

const GIT_ENV = {
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_TERMINAL_PROMPT: "0",
};

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await run("git", [...CONFIG, ...args], {
    cwd,
    env: { ...process.env, ...GIT_ENV },
    maxBuffer: 64 * 1024 * 1024,
    windowsHide: true,
  });
  return stdout;
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
 * Creates the bare repo (the record) and its working clone (the cache).
 *
 * The bare repo is what a sandbox will clone later, which is why it exists even
 * though nothing remote is involved yet: it keeps `repo_url` meaningful for
 * every session, including folders the user opened with no Git remote at all.
 */
export async function createRepo(id: string): Promise<void> {
  const bare = barePath(id);
  const work = workPath(id);

  await mkdir(dirname(bare), { recursive: true });
  await mkdir(work, { recursive: true });

  await git(dirname(bare), ["init", "--bare", "-b", BASE_BRANCH, bare]);
  await git(work, ["init", "-b", BASE_BRANCH]);
  await git(work, ["remote", "add", "origin", bare]);
}

// ---------------------------------------------------------------------------
// Project canonical repo — the single source of truth (Git/Branch model)
// ---------------------------------------------------------------------------

const PROJECT_REMOTE = "project";

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * Ensures the project's canonical bare repo exists with an initial `main`.
 *
 * Idempotent: rooms call it on the way to forking, and only the first one does
 * any work. `main` starts as an empty root commit so a room always has a real
 * commit to fork from, even before anyone has published anything.
 */
export async function ensureProjectRepo(projectId: string): Promise<void> {
  const bare = projectBarePath(projectId);
  if (await exists(bare)) return;

  await mkdir(dirname(bare), { recursive: true });
  await git(dirname(bare), ["init", "--bare", "-b", BASE_BRANCH, bare]);

  // A bare repo can't hold a commit on its own; make the root commit in a throwaway
  // work tree and push it, so `main` exists for the first fork.
  const seed = join(dirname(bare), `.seed-${projectId}`);
  await mkdir(seed, { recursive: true });
  try {
    await git(seed, ["init", "-b", BASE_BRANCH]);
    await git(seed, ["commit", "--allow-empty", "-m", "Initialize project"]);
    await git(seed, ["remote", "add", "origin", bare]);
    await git(seed, ["push", "origin", BASE_BRANCH]);
  } finally {
    await rm(seed, { recursive: true, force: true });
  }
}

/**
 * Creates a room as a branch of the project: its bare repo is a clone of the
 * project's, so it starts at the project's current `main`, and `session/<id>`
 * forks from there. The room also keeps the project repo as a `project` remote
 * for later publish and sync.
 *
 * This is the fork half of the Git/Branch model; publishRoom is the merge half.
 */
export async function forkRoomFromProject(
  roomId: string,
  projectId: string,
  rootName: string,
): Promise<SessionRepo> {
  await ensureProjectRepo(projectId);
  const projectBare = projectBarePath(projectId);
  const bare = barePath(roomId);
  const work = workPath(roomId);
  const branch = sessionBranchOf(roomId);

  await mkdir(dirname(bare), { recursive: true });
  await mkdir(dirname(work), { recursive: true });

  // Room bare = a clone of the project repo, so it carries the shared main.
  await git(dirname(bare), ["clone", "--bare", projectBare, bare]);
  // Working copy clones the room bare (its origin), matching every other room.
  await git(dirname(work), ["clone", "--branch", BASE_BRANCH, bare, work]);
  await git(work, ["remote", "add", PROJECT_REMOTE, projectBare]);

  const baseSha = (await git(work, ["rev-parse", "HEAD"])).trim();
  await git(work, ["checkout", "-b", branch]);
  await git(work, ["push", "-u", "origin", branch]);

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

/** Makes sure the room's working copy has the project repo as a remote. */
async function ensureProjectRemote(work: string, projectId: string): Promise<void> {
  const has = await gitOk(work, ["remote", "get-url", PROJECT_REMOTE]);
  if (!has) await git(work, ["remote", "add", PROJECT_REMOTE, projectBarePath(projectId)]);
}

/**
 * Publishes a room's work back to the project's `main` — the "merge back to the
 * source of truth" step.
 *
 * The project's latest main is merged into the room branch first, so publishing
 * is always a fast-forward of main and never clobbers a concurrent publish from
 * another room. A merge conflict aborts cleanly and is reported, leaving both
 * the room and the project exactly as they were.
 */
export async function publishRoom(roomId: string, projectId: string): Promise<MergeResult> {
  const work = workPath(roomId);
  return withRepoLock(roomId, async () => {
    await ensureProjectRemote(work, projectId);
    await git(work, ["fetch", PROJECT_REMOTE, BASE_BRANCH]);

    const merged = await gitOk(work, ["merge", "--no-edit", `${PROJECT_REMOTE}/${BASE_BRANCH}`]);
    if (!merged) {
      const files = await conflictedFiles(work);
      await gitOk(work, ["merge", "--abort"]);
      return { ok: false, reason: "conflict", files };
    }

    await git(work, ["push", PROJECT_REMOTE, `HEAD:${BASE_BRANCH}`]);
    const sha = (await git(work, ["rev-parse", "HEAD"])).trim();
    // Keep the room's own branch ref in step with what was published.
    await gitOk(work, ["push", "origin", sessionBranchOf(roomId)]);
    return { ok: true, sha };
  });
}

/**
 * Pulls the project's latest `main` into a room — the reverse of publish, for
 * picking up what other rooms have merged without leaving the room.
 */
export async function syncRoom(roomId: string, projectId: string): Promise<MergeResult> {
  const work = workPath(roomId);
  return withRepoLock(roomId, async () => {
    await ensureProjectRemote(work, projectId);
    await git(work, ["fetch", PROJECT_REMOTE, BASE_BRANCH]);

    const merged = await gitOk(work, ["merge", "--no-edit", `${PROJECT_REMOTE}/${BASE_BRANCH}`]);
    if (!merged) {
      const files = await conflictedFiles(work);
      await gitOk(work, ["merge", "--abort"]);
      return { ok: false, reason: "conflict", files };
    }

    const sha = (await git(work, ["rev-parse", "HEAD"])).trim();
    await gitOk(work, ["push", "origin", sessionBranchOf(roomId)]);
    return { ok: true, sha };
  });
}

/** The current `main` of a project's canonical repo, or null if uninitialised. */
export async function projectHeadSha(projectId: string): Promise<string | null> {
  const bare = projectBarePath(projectId);
  if (!(await exists(bare))) return null;
  try {
    return (await git(bare, ["rev-parse", BASE_BRANCH])).trim();
  } catch {
    return null;
  }
}

/**
 * Verify a commit a runner claims to have produced: it must exist in the bare
 * repo and extend the base the run started from. This is what stops a
 * completion report from pointing the head at history that was never pushed
 * through the guarded smart-HTTP endpoint (or at someone else's commit).
 */
export async function verifyPushedCommit(
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
 * Every tracked path at the project's `main` HEAD, read straight from the bare
 * repo — no working copy needed, so this is safe from any process. Used by the
 * repo-context indexer (app/lib/knowledge/repo-context.ts).
 */
export async function listProjectFiles(projectId: string): Promise<string[]> {
  const bare = projectBarePath(projectId);
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
 * a chat actually edits, not just the project's canonical main.
 */

/** The head of a room repo's working branch, straight from its bare repo. */
export async function repoRefHeadSha(id: string): Promise<string | null> {
  const bare = barePath(id);
  if (!(await exists(bare))) return null;
  try {
    return (await git(bare, ["rev-parse", sessionBranchOf(id)])).trim();
  } catch {
    return null;
  }
}

/** Every tracked path at a room repo's working-branch head. */
export async function listRepoRefFiles(id: string): Promise<string[]> {
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
export async function readRepoRefFileText(
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
 * One file's text at the project's `main` HEAD, or null when it is missing,
 * binary, or the path is unsafe. Truncated to `maxBytes` — the callers distill
 * summaries, so a file's head is all they need.
 */
export async function readProjectFileText(
  projectId: string,
  relative: string,
  maxBytes = 64 * 1024,
): Promise<string | null> {
  const path = safeRelativePath(relative);
  if (!path) return null;
  const bare = projectBarePath(projectId);
  if (!(await exists(bare))) return null;
  try {
    const out = await git(bare, ["show", `${BASE_BRANCH}:${path}`]);
    if (out.includes("\0")) return null;
    return out.length > maxBytes ? out.slice(0, maxBytes) : out;
  } catch {
    return null;
  }
}

async function conflictedFiles(work: string): Promise<string[]> {
  try {
    const out = await git(work, ["diff", "--name-only", "--diff-filter=U"]);
    return out.split("\n").map((line) => line.trim()).filter(Boolean);
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// Seeding
// ---------------------------------------------------------------------------

export type SeedOutcome = { written: number; skipped: string[] };

/** Writes one batch of uploaded files into the working copy. Does not commit. */
export async function writeSeedBatch(
  id: string,
  files: { path: string; data: string }[],
): Promise<SeedOutcome> {
  const work = workPath(id);
  const skipped: string[] = [];
  let written = 0;

  for (const file of files) {
    const relative = safeRelativePath(file.path);
    const absolute = relative ? resolveInside(work, relative) : null;
    if (!relative || !absolute) {
      skipped.push(String(file.path));
      continue;
    }

    const bytes = Buffer.from(file.data, "base64");
    if (bytes.byteLength > MAX_SEED_FILE_BYTES) {
      skipped.push(relative);
      continue;
    }

    await mkdir(dirname(absolute), { recursive: true });
    await writeFile(absolute, bytes);
    written += 1;
  }

  return { written, skipped };
}

/**
 * Commits the seeded tree onto the base branch, then forks the session branch
 * from it. Base and session start level, so drift begins at zero and is always
 * measured against a real commit.
 */
export async function finishSeed(id: string, rootName: string): Promise<SessionRepo> {
  const work = workPath(id);
  const branch = sessionBranchOf(id);

  await git(work, ["add", "-A"]);
  // --allow-empty: an empty folder still needs a base commit to fork from.
  await git(work, ["commit", "--allow-empty", "-m", "Seed session"]);

  const baseSha = (await git(work, ["rev-parse", "HEAD"])).trim();
  await git(work, ["push", "origin", BASE_BRANCH]);

  await git(work, ["checkout", "-b", branch]);
  await git(work, ["push", "-u", "origin", branch]);

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
      const bytes = await readFile(absolute);
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
  const work = workPath(id);
  for (const name of SPEC_DOCS) {
    try {
      const sha = (await git(work, ["rev-parse", `HEAD:${name}`])).trim();
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
export async function listTree(id: string, rootName: string): Promise<TreeNode> {
  const work = workPath(id);
  const stdout = await git(work, ["ls-tree", "-r", "-l", "--full-tree", "HEAD"]);
  return buildTree(rootName, parseLsTree(stdout));
}

/**
 * Files that differ between the seed commit and HEAD — everything the session's
 * people and agents have changed. Rename/copy lines carry two paths; the new
 * one is what the explorer opens.
 */
/** Added/removed line totals between two commits, for a run's diff badge. */
export async function diffStat(
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
export async function diffStatBare(
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
export async function diffFilesBare(id: string, base: string, head: string): Promise<FileChange[]> {
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

export async function listChangedFiles(id: string, baseSha: string): Promise<ChangedFile[]> {
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

/** `<mode> SP <type> SP <sha> SP* <size> TAB <path>` */
function parseLsTree(stdout: string): TreeEntry[] {
  const entries: TreeEntry[] = [];

  for (const line of stdout.split("\n")) {
    const tabAt = line.indexOf("\t");
    if (tabAt < 0) continue;

    const fields = line.slice(0, tabAt).trim().split(/\s+/);
    if (fields.length < 4 || fields[1] !== "blob") continue;

    const size = Number(fields[3]);
    entries.push({
      path: line.slice(tabAt + 1),
      size: Number.isFinite(size) ? size : 0,
    });
  }

  return entries;
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
export async function readRepoFile(id: string, relative: string): Promise<RepoFile | null> {
  const absolute = resolveInside(workPath(id), relative);
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

export async function readRepoBytes(id: string, relative: string): Promise<Buffer | null> {
  const absolute = resolveInside(workPath(id), relative);
  if (!absolute) return null;
  try {
    return await readFile(absolute);
  } catch {
    return null;
  }
}

export async function headSha(id: string): Promise<string> {
  return (await git(workPath(id), ["rev-parse", "HEAD"])).trim();
}

// ---------------------------------------------------------------------------
// Writing
// ---------------------------------------------------------------------------

export async function writeRepoFile(id: string, relative: string, text: string): Promise<boolean> {
  const absolute = resolveInside(workPath(id), relative);
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
    await run("git", ["merge-file", "-L", "current", "-L", "base", "-L", "incoming", ours, base, theirs], {
      windowsHide: true,
    });
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
export async function mergeSave(
  id: string,
  relative: string,
  baseText: string,
  incomingText: string,
  headAtRequest: string,
  author: { name: string; email: string },
): Promise<SaveResult> {
  const work = workPath(id);
  return withRepoLock(id, async () => {
    await ensureWork(id, headAtRequest);

    const absolute = resolveInside(work, relative);
    if (!absolute) throw new Error("Unsafe path.");

    let ours = "";
    try {
      ours = await readFile(absolute, "utf8");
    } catch {
      ours = ""; // new file
    }

    if (ours === incomingText) return { status: "nochange", headSha: await headSha(id) };

    // Fast path: the file hasn't moved under the editor, so the write is safe.
    if (ours === baseText) {
      await writeRepoFile(id, relative, incomingText);
      const sha = await commitWork(id, `WIP: ${relative}`, author.name, author.email);
      return { status: "clean", headSha: sha ?? (await headSha(id)) };
    }

    // The file changed under the editor — merge the two sets of edits.
    const scratch = join(dirname(work), `.merge-${randomBytes(6).toString("hex")}`);
    await mkdir(scratch, { recursive: true });
    try {
      const oursTmp = join(scratch, "ours");
      const baseTmp = join(scratch, "base");
      const theirsTmp = join(scratch, "theirs");
      await writeFile(oursTmp, ours, "utf8");
      await writeFile(baseTmp, baseText, "utf8");
      await writeFile(theirsTmp, incomingText, "utf8");

      const conflicts = await mergeFile(oursTmp, baseTmp, theirsTmp);
      if (conflicts !== 0) {
        // Leave the room untouched; the client keeps the user's text to resolve.
        return { status: "conflict", headSha: await headSha(id) };
      }

      const merged = await readFile(oursTmp, "utf8");
      await writeRepoFile(id, relative, merged);
      const sha = await commitWork(id, `WIP: ${relative}`, author.name, author.email);
      return { status: "clean", headSha: sha ?? (await headSha(id)) };
    } finally {
      await rm(scratch, { recursive: true, force: true });
    }
  });
}

/**
 * Commits whatever is dirty and pushes it. Returns null when the tree was
 * already clean, so a redundant save does not manufacture an empty commit.
 */
export async function commitWork(
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
  await gitOk(work, ["push", "origin", sessionBranchOf(id)]);
  return sha;
}

/** Restores the working copy to a session's recorded HEAD. */
export async function checkoutHead(id: string, sha: string): Promise<void> {
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
export async function ensureWork(id: string, sha: string): Promise<void> {
  const work = workPath(id);
  const branch = sessionBranchOf(id);

  if (await isWorkTree(work)) return;

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
