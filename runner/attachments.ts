/*
 * Files attached to a message, placed in the chat's worktree before the agent
 * starts. The agent opens them with its own tools, as Claude Code or Codex
 * would open any file, so their size is not limited by the prompt.
 *
 * They live under `.multicode/attachments/<turn>/`, which is added to the
 * repository's `info/exclude`: never committed, never pushed, never part of a
 * checkpoint, and invisible to the "unfinished edits" check on the next turn.
 * Each download is checked against the size and sha256 the server recorded.
 */
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { createWriteStream } from "node:fs";
import { appendFile, mkdir, readdir, readFile, rename, rm, stat } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { promisify } from "node:util";

const run = promisify(execFile);
export const ATTACHMENT_ROOT = ".multicode/attachments";
const EXCLUDE = "/.multicode/";
/** Earlier turns' attachments stay for follow-ups in the same chat, for a while. */
const KEEP_MS = 7 * 24 * 60 * 60 * 1000;

export type JobAttachment = { id: string; path: string; size: number; sha256: string };
type Fetch = (attachmentId: string) => Promise<ReadableStream<Uint8Array>>;

/** The destination inside the worktree, or an error for anything else. */
export function attachmentDestination(worktree: string, path: string) {
  if (!/^\.multicode\/attachments\/[0-9a-f-]{36}\/[^/\\]+$/.test(path) || path.split("/").some(part => part === ".." || part === "."))
    throw new Error(`Refusing an attachment outside ${ATTACHMENT_ROOT}: ${path}`);
  const destination = resolve(worktree, path);
  const inside = relative(resolve(worktree, ATTACHMENT_ROOT), destination);
  if (!inside || inside.startsWith("..") || isAbsolute(inside)) throw new Error(`Refusing an attachment outside ${ATTACHMENT_ROOT}: ${path}`);
  return destination;
}

/** Keep `.multicode/` out of Git for this repository (shared by its worktrees). */
export async function excludeFromGit(worktree: string) {
  // Worktrees share their repository's info/exclude (the common Git dir).
  const { stdout } = await run("git", ["rev-parse", "--git-common-dir"], { cwd: worktree });
  const file = join(resolve(worktree, stdout.trim()), "info", "exclude");
  const current = await readFile(file, "utf8").catch(() => "");
  if (current.split(/\r?\n/).includes(EXCLUDE)) return;
  await mkdir(dirname(file), { recursive: true });
  await appendFile(file, `${current && !current.endsWith("\n") ? "\n" : ""}# Files attached to chat messages (multicode runner)\n${EXCLUDE}\n`);
}

async function download(fetchAttachment: Fetch, file: JobAttachment, destination: string) {
  const existing = await stat(destination).catch(() => null);
  if (existing?.size === file.size && createHash("sha256").update(await readFile(destination)).digest("hex") === file.sha256) return;
  await mkdir(dirname(destination), { recursive: true });
  const partial = `${destination}.partial`;
  const hash = createHash("sha256");
  let received = 0;
  const check = new Transform({
    transform(chunk: Buffer, _encoding, done) {
      received += chunk.length;
      if (received > file.size) return done(new Error("Attachment is larger than recorded."));
      hash.update(chunk);
      done(null, chunk);
    },
  });
  try {
    await pipeline(Readable.fromWeb((await fetchAttachment(file.id)) as import("node:stream/web").ReadableStream<Uint8Array>), check, createWriteStream(partial, { mode: 0o600 }));
    if (received !== file.size || hash.digest("hex") !== file.sha256) throw new Error("Attachment did not match what was uploaded.");
    await rename(partial, destination);
  } catch (error) {
    await rm(partial, { force: true });
    throw error;
  }
}

/** Remove other turns' attachment folders that are older than a week. */
async function prune(worktree: string, keepTurn: string, now = Date.now()) {
  const root = join(worktree, ATTACHMENT_ROOT);
  for (const name of await readdir(root).catch(() => [] as string[])) {
    if (name === keepTurn || !/^[0-9a-f-]{36}$/.test(name)) continue;
    const info = await stat(join(root, name)).catch(() => null);
    if (info && now - info.mtimeMs > KEEP_MS) await rm(join(root, name), { recursive: true, force: true });
  }
}

/** Put a turn's attachments in its worktree; returns how many there were. */
export async function placeAttachments(worktree: string, turnId: string, files: JobAttachment[] | undefined, fetchAttachment: Fetch) {
  if (!files?.length) return 0;
  await excludeFromGit(worktree);
  for (const file of files) await download(fetchAttachment, file, attachmentDestination(worktree, file.path));
  await prune(worktree, turnId);
  return files.length;
}
