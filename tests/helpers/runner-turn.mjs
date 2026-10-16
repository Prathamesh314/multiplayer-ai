// What a member's computer does for one AI turn, for tests: claim the turn as
// that member's device, then clone, edit, commit and push the candidate to
// refs/turns/<turn> from a separate "computer" directory. The server never
// checks out code; only this simulated computer does.
import { execFile } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { barePath } from "../../app/lib/session/paths.ts";
import { claimNextJob } from "../../app/lib/runner/jobs.ts";

const run = promisify(execFile);
const devices = new Map();

/** The member's connected computer: a paired, online runner for these agents. */
export async function deviceFor(sql, userId, agentIds = ["codex"]) {
  const key = `${userId}:${agentIds.join(",")}`;
  if (!devices.has(key)) {
    const id = (await sql(`INSERT INTO runner_devices(user_id,name,token_hash,version,agent_ids,last_seen_at,supports_inputs,supports_isolated_chats)
      VALUES ($1,'Test computer',$2,'2',$3,now(),true,true) RETURNING id`,
      [userId, createHash("sha256").update(randomBytes(32)).digest(), agentIds])).rows[0].id;
    devices.set(key, id);
  }
  return devices.get(key);
}

/** Claim a prepared turn on the member's computer; it then runs there under a lease. */
export async function claimTurn(sql, job) {
  const deviceId = await deviceFor(sql, job.userId, [job.agentId]);
  const claimed = await claimNextJob({ userId: job.userId, deviceId });
  if (claimed?.job.turnId !== job.turnId) throw new Error(`Expected to claim turn ${job.turnId}, claimed ${claimed?.job.turnId ?? "nothing"}`);
  return { deviceId, job: claimed.job };
}

const git = (cwd, ...args) => run("git", ["-c", "commit.gpgsign=false", "-c", "core.autocrlf=false", ...args], { cwd }).then(result => result.stdout.trim());

/**
 * The runner's work for a turn, on the member's computer: start from `baseSha`,
 * apply `edit(work)`, commit, and push the candidate to refs/turns/<turnId>.
 * Null when the edit changed nothing.
 */
export async function commitOnComputer(repoRef, turnId, baseSha, edit, author = { name: "Agent", email: "agent@example.test" }) {
  const work = await mkdtemp(join(tmpdir(), "member-computer-"));
  try {
    await git(tmpdir(), "clone", "--quiet", "--no-checkout", barePath(repoRef), work);
    await git(work, "checkout", "--quiet", "--detach", baseSha);
    await edit(work);
    await git(work, "add", "-A");
    if (!await git(work, "status", "--porcelain")) return null;
    await git(work, "-c", `user.name=${author.name}`, "-c", `user.email=${author.email}`, "commit", "--quiet", "-m", "agent turn");
    const sha = await git(work, "rev-parse", "HEAD");
    await git(work, "push", "--quiet", "origin", `HEAD:refs/turns/${turnId}`);
    return sha;
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}
