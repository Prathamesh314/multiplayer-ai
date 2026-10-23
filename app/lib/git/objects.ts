import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { inheritedRepoLocks } from "../session/lock";
import { gitCommand } from "./command";

/** Bounded Git plumbing with no inherited repository paths or executable hooks. */
export function objectGit(cwd: string, args: string[], input?: Buffer | string, extraEnv: Partial<NodeJS.ProcessEnv> = {}, maxBytes = 16 * 1024 * 1024): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const env = { ...process.env };
    for (const key of Object.keys(env)) if (key.startsWith("GIT_")) delete env[key];
    const child = spawn(...gitCommand(["-c", "user.name=multicode-ai", "-c", "user.email=sessions@multicode-ai.local", "-c", "commit.gpgsign=false", "-c", "core.hooksPath=/dev/null", "-c", "gc.auto=0", ...args]), {
      cwd, windowsHide: true, env: { ...env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_NO_REPLACE_OBJECTS: "1", GIT_TERMINAL_PROMPT: "0", ...extraEnv },
      stdio: ["pipe", "pipe", "pipe", ...inheritedRepoLocks()],
    });
    const chunks: Buffer[] = []; let bytes = 0; let stderr = ""; let failure: Error | undefined;
    const timer = setTimeout(() => { failure = new Error("Git operation timed out."); child.kill(); }, 120_000);
    child.stdout!.on("data", (chunk: Buffer) => { bytes += chunk.length; if (bytes > maxBytes) { failure = new Error("Git output exceeds the read limit."); child.kill(); } else chunks.push(chunk); });
    child.stderr!.on("data", chunk => { stderr = (stderr + chunk.toString()).slice(-8192); });
    child.stdin!.on("error", () => {});
    child.on("error", error => { clearTimeout(timer); reject(error); });
    child.on("close", code => { clearTimeout(timer); if (failure) reject(failure); else if (code) reject(Object.assign(new Error(stderr || `Git ${args[0]} failed (${code})`), { code, stdout: Buffer.concat(chunks) })); else resolve(Buffer.concat(chunks)); });
    child.stdin!.end(input);
  });
}
export async function objectText(cwd: string, args: string[], input?: Buffer | string, env?: Partial<NodeJS.ProcessEnv>): Promise<string> {
  return (await objectGit(cwd, args, input, env)).toString("utf8").trim();
}
export async function withTemporaryIndex<T>(bare: string, action: (env: Partial<NodeJS.ProcessEnv>) => Promise<T>): Promise<T> {
  const scratch = await mkdtemp(join(bare, "tmp-index-"));
  try { return await action({ GIT_INDEX_FILE: join(scratch, "index") }); }
  finally { await rm(scratch, { recursive: true, force: true }); }
}
export async function putBlob(bare: string, index: Partial<NodeJS.ProcessEnv>, path: string, bytes: Buffer | string, mode = "100644") {
  const sha = await objectText(bare, ["hash-object", "-w", "--stdin"], bytes);
  await objectGit(bare, ["update-index", "-z", "--index-info"], `${mode} ${sha}\t${path}\0`, index);
}

/** Import a bounded batch without a checkout or a Git process per file.
 * Only blob bytes enter fast-import; paths go through NUL-delimited index-info.
 * Await completion before publishing the index so every referenced object is
 * durable and a failed import leaves the previous index available for retry.
 */
export async function putBlobs(bare: string, index: Partial<NodeJS.ProcessEnv>, files: { path: string; bytes: Buffer }[]) {
  if (!files.length) return;
  const input: Buffer[] = [];
  for (let i = 0; i < files.length; i++) {
    const mark = i + 1;
    const bytes = files[i].bytes;
    input.push(Buffer.from(`blob\nmark :${mark}\ndata ${bytes.length}\n`), bytes, Buffer.from(`\nget-mark :${mark}\n`));
  }
  input.push(Buffer.from("done\n"));
  const output = await objectText(bare, ["fast-import", "--quiet", "--done"], Buffer.concat(input));
  const hashes = output.split("\n");
  if (hashes.length !== files.length || hashes.some(hash => !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(hash))) {
    throw new Error("Git returned an invalid import result.");
  }
  await objectGit(bare, ["update-index", "-z", "--index-info"],
    files.map((file, i) => `100644 ${hashes[i]}\t${file.path}\0`).join(""), index);
}
export async function commitTree(bare: string, tree: string, parents: string[], message: string, author?: { name: string; email: string }) {
  // write-tree can return Git's virtual empty tree without storing its bytes.
  // Persist it before committing so empty projects pass fsck and backup checks.
  await objectText(bare, ["mktree"], "");
  return objectText(bare, ["commit-tree", tree, ...parents.flatMap(sha => ["-p", sha]), "-m", message], undefined,
    author ? { GIT_AUTHOR_NAME: author.name, GIT_AUTHOR_EMAIL: author.email, GIT_COMMITTER_NAME: author.name, GIT_COMMITTER_EMAIL: author.email } : undefined);
}
