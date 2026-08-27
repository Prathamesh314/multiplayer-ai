import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { buildTree, type TreeEntry } from "../tree";
import type { TreeNode } from "../types";
import { barePath, resolveInside, safeRelativePath, workPath } from "./paths";
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
 */
const locks = new Map<string, Promise<unknown>>();

export async function withRepoLock<T>(id: string, task: () => Promise<T>): Promise<T> {
  const previous = locks.get(id) ?? Promise.resolve();
  const result = previous.then(task, task);
  // A failure must not poison the queue, so what the next caller waits on is
  // the settled form. The caller still sees the rejection through `result`.
  const settled = result.then(
    () => undefined,
    () => undefined,
  );

  locks.set(id, settled);
  try {
    return await result;
  } finally {
    if (locks.get(id) === settled) locks.delete(id);
  }
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
