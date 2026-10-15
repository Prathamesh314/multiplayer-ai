import type { PoolClient } from "pg";
import { queryOne, transaction } from "../db/client";
import { events } from "../events";
import { ensureRepoContext } from "../knowledge/repo-context";
import { projectRepositoryForRoom } from "../project/repositories";
import {
  aheadBehind, branchTip, chatBranchOf, commitParents, committedChanges, conflictMarkerFiles, diffFilesBare, diffPath,
  mergeBase, mergeCommits, moveBranch, sessionBranchOf, withRepoLock,
} from "../session/repo";
import type { ChangedFile } from "../session/types";
import type { MergeState } from "./isolation";
import { appendMessage } from "./runs";
import { ControlError } from "./turns";

/*
 * Reviewing and integrating a parallel chat's branch (see isolation.ts).
 *
 * Merge brings the chat's branch into the room branch; update brings the
 * room's latest work into the chat's branch. Both are compare-and-swap on
 * heads the client last saw, run under the repository lock, and record the
 * new head in the same transaction that checked it. A merge is a real merge
 * commit, never a squash: shared memory publishes a turn only once its commit
 * is an ancestor of the published branch.
 *
 * A Git ref can move and the transaction then fail to commit. The next
 * attempt recognises its own earlier result from the commit graph (a merge of
 * exactly the recorded heads, or a fast-forward to one of them) and finishes
 * recording it; any other mismatch is refused.
 */

export type ChatFile = ChangedFile & { added: number; removed: number };

export type ChatBranchState = {
  runId: string;
  mergeState: MergeState;
  chatHead: string;
  roomHead: string;
  /** Where the chat's branch last met the room's: the diff is base..chatHead. */
  base: string;
  /** Commits on the chat's branch the room lacks, and the reverse. */
  ahead: number;
  behind: number;
  mergedSha: string | null;
  files: ChatFile[];
  /** Files that still carry merge conflict markers; the chat cannot merge until they are resolved. */
  conflictMarkers: string[];
  /** The chat's live control state, so a view opened earlier acts on current values. */
  running: boolean;
  driverUserId: string;
  controlVersion: number;
};

export type ChatMergeOutcome =
  | { ok: true; sha: string; changed: boolean }
  | { ok: false; reason: "conflict" | "markers"; files: string[] };

export type ChatUpdateOutcome =
  | { ok: true; sha: string; changed: boolean; conflicts: string[] }
  | { ok: false; reason: "conflict"; files: string[] };

type Actor = { id: string; name: string; email: string };
type RunRow = {
  id: string; session_id: string; repo_id: string | null; title: string | null; isolation: string; status: string;
  head_sha: string | null; merge_state: MergeState | null; merged_sha: string | null; driver_user_id: string;
  control_version: number; role: string | null;
};

const repoRefOf = (run: Pick<RunRow, "repo_id" | "session_id">) => run.repo_id ?? run.session_id;

async function loadRun(tx: Pick<PoolClient, "query">, runId: string, sessionId: string, actorId: string, lock: boolean): Promise<RunRow> {
  const { rows: [run] } = await tx.query<RunRow>(
    `SELECT r.*, room_access_role(r.session_id, $3) AS role FROM agent_runs r
      WHERE r.id = $1 AND r.session_id = $2 ${lock ? "FOR UPDATE" : ""}`, [runId, sessionId, actorId]);
  if (!run) throw new ControlError("Chat not found.", 404);
  if (run.isolation !== "isolated" || !run.head_sha) throw new ControlError("Only parallel chats have a branch of their own.", 400);
  return run;
}

async function roomHead(tx: Pick<PoolClient, "query">, run: RunRow, lock: boolean): Promise<string> {
  const { rows: [repo] } = run.repo_id
    ? await tx.query<{ head_sha: string | null }>(`SELECT head_sha FROM room_repos WHERE id = $1 AND session_id = $2 ${lock ? "FOR UPDATE" : ""}`, [run.repo_id, run.session_id])
    : await tx.query<{ head_sha: string | null }>(`SELECT head_sha FROM session_repos WHERE session_id = $1 ${lock ? "FOR UPDATE" : ""}`, [run.session_id]);
  if (!repo?.head_sha) throw new ControlError("The chat's repository is not ready.");
  return repo.head_sha;
}

function requireEditor(run: RunRow) {
  if (!["owner", "editor"].includes(run.role ?? "")) throw new ControlError("This needs edit access to the room.", 403);
}

function requireIdle(run: RunRow) {
  if (["running", "queued"].includes(run.status)) throw new ControlError("Wait for the chat's active turn to finish.");
}

/** Whether `tip` is what merging `theirs` into `ours` produced: a fast-forward, or a merge of exactly those two. */
async function producedBy(repoRef: string, tip: string, ours: string, theirs: string): Promise<boolean> {
  if (tip === theirs) return true;
  const parents = await commitParents(repoRef, tip);
  return parents.length === 2 && parents[0] === ours && parents[1] === theirs;
}

async function proposalFiles(repoRef: string, base: string, head: string): Promise<ChatFile[]> {
  if (base === head) return [];
  const [changes, counts] = await Promise.all([committedChanges(repoRef, base, head), diffFilesBare(repoRef, base, head)]);
  const lines = new Map(counts.map(file => [file.path, file]));
  return changes.map(file => ({ ...file, added: lines.get(file.path)?.added ?? 0, removed: lines.get(file.path)?.removed ?? 0 }));
}

async function heads(runId: string, sessionId: string, actorId: string) {
  const { run, room } = await transaction(async tx => {
    const run = await loadRun(tx, runId, sessionId, actorId, false);
    return { run, room: await roomHead(tx, run, false) };
  });
  const chat = run.head_sha!;
  const repoRef = repoRefOf(run);
  return { run, repoRef, room, chat, base: await mergeBase(repoRef, room, chat) ?? chat };
}

/** What the chat would bring into the room right now. Readable by anyone who can see the room. */
export async function chatBranchState(runId: string, sessionId: string, actorId: string): Promise<ChatBranchState> {
  const { run, repoRef, room, chat, base } = await heads(runId, sessionId, actorId);
  const [{ leftOnly: behind, rightOnly: ahead }, files, conflictMarkers] = await Promise.all([
    aheadBehind(repoRef, room, chat), proposalFiles(repoRef, base, chat), base === chat ? [] : conflictMarkerFiles(repoRef, base, chat),
  ]);
  return { runId, mergeState: run.merge_state ?? "open", chatHead: chat, roomHead: room, base, ahead, behind,
    mergedSha: run.merged_sha, files, conflictMarkers,
    running: ["running", "queued"].includes(run.status), driverUserId: run.driver_user_id, controlVersion: run.control_version };
}

/** One file's diff in the chat's proposal, from where it last met the room branch. */
export async function chatFileDiff(runId: string, sessionId: string, actorId: string, path: string): Promise<string> {
  const { repoRef, chat, base } = await heads(runId, sessionId, actorId);
  return base === chat ? "" : diffPath(repoRef, base, chat, path);
}

/** Record the change in the chat's transcript and tell the room. */
async function announce(run: RunRow, body: string, branch: { mergeState: MergeState; headSha: string }) {
  const message = await appendMessage({ runId: run.id, role: "system", body });
  const bus = await events();
  await bus.publish(run.session_id, { type: "run.turn", runId: run.id, seq: message.seq, role: "system", authorName: null, body, at: Date.now() }).catch(() => {});
  await bus.publish(run.session_id, { type: "run.branch", runId: run.id, mergeState: branch.mergeState, headSha: branch.headSha, at: Date.now() }).catch(() => {});
}

/**
 * Merge the chat's branch into the room branch. Any room editor may merge;
 * the room branch moves only if both heads are still the ones the caller
 * reviewed, and never while the chat has unresolved conflict markers.
 */
export async function mergeChatIntoRoom(input: { runId: string; sessionId: string; actor: Actor; expectedChatHead: string; expectedRoomHead: string }): Promise<ChatMergeOutcome> {
  const { run } = await transaction(async tx => ({ run: await loadRun(tx, input.runId, input.sessionId, input.actor.id, false) }));
  const repoRef = repoRefOf(run);
  const outcome = await withRepoLock(repoRef, () => transaction(async (tx): Promise<ChatMergeOutcome & { previous?: string }> => {
    const current = await loadRun(tx, input.runId, input.sessionId, input.actor.id, true);
    requireEditor(current);
    requireIdle(current);
    if (current.merge_state === "discarded") throw new ControlError("This parallel chat was discarded. Reopen it before merging.");
    const room = await roomHead(tx, current, true);
    const chat = current.head_sha!;
    if (chat !== input.expectedChatHead || room !== input.expectedRoomHead) {
      throw new ControlError("The chat or the room changed. Review the latest changes before merging.");
    }
    if (await branchTip(repoRef, chatBranchOf(current.id)) !== chat) throw new ControlError("The chat's branch does not match its record. Refresh and try again.");
    const roomBranch = sessionBranchOf(repoRef);
    const gitRoom = await branchTip(repoRef, roomBranch);
    let merged: string;
    if (gitRoom !== room) {
      // An earlier attempt moved the branch but did not record it.
      if (!gitRoom || !await producedBy(repoRef, gitRoom, room, chat)) throw new ControlError("The room's branch changed outside this merge. Refresh and try again.");
      merged = gitRoom;
    } else {
      const base = await mergeBase(repoRef, room, chat);
      const markers = base && base !== chat ? await conflictMarkerFiles(repoRef, base, chat) : [];
      if (markers.length) return { ok: false, reason: "markers", files: markers };
      const result = await mergeCommits(repoRef, room, chat, {
        message: `Merge parallel chat "${(current.title ?? "Untitled chat").slice(0, 120)}"`, author: { name: input.actor.name, email: input.actor.email },
      });
      if (!result.ok) return result;
      if (result.sha !== room) await moveBranch(repoRef, roomBranch, result.sha, room);
      merged = result.sha;
    }
    await tx.query(current.repo_id ? `UPDATE room_repos SET head_sha = $2 WHERE id = $1` : `UPDATE session_repos SET head_sha = $2 WHERE session_id = $1`, [repoRef, merged]);
    await tx.query(`UPDATE agent_runs SET merge_state = 'merged', merged_sha = $2, merged_at = now(), merged_by = $3 WHERE id = $1`, [current.id, merged, input.actor.id]);
    return { ok: true, sha: merged, changed: merged !== room, previous: room };
  }));
  if (!outcome.ok) return outcome;
  if (outcome.changed) {
    await (await events()).publish(run.session_id, { type: "file.saved", repoId: run.repo_id, path: "", headSha: outcome.sha,
      authorId: input.actor.id, authorName: `${input.actor.name} · merged a parallel chat`, originId: null, at: Date.now() }).catch(() => {});
    // Same rule as finalize: a room branch that Publish gates is indexed when published.
    const session = await queryOne<{ project_id: string | null }>(`SELECT project_id FROM sessions WHERE id = $1`, [run.session_id]);
    const publishGated = !!session?.project_id && (run.repo_id === null || !!await projectRepositoryForRoom(run.session_id, run.repo_id));
    if (!publishGated) await ensureRepoContext(repoRef, outcome.sha);
  }
  await announce(run, outcome.changed
    ? `${input.actor.name} merged this chat into the room (${outcome.sha.slice(0, 8)}).`
    : `${input.actor.name} marked this chat merged; the room already had its changes.`, { mergeState: "merged", headSha: run.head_sha! });
  return { ok: true, sha: outcome.sha, changed: outcome.changed };
}

/**
 * Bring the room's latest work into the chat's branch, so the chat continues
 * from it and merges cleanly later. Only the chat's driver may do this, as
 * with a turn. With `allowConflicts`, a conflicted merge is committed to the
 * chat's branch with conflict markers for its agent to resolve next.
 */
export async function updateChatFromRoom(input: {
  runId: string; sessionId: string; actor: Actor; version: number; expectedChatHead: string; expectedRoomHead: string; allowConflicts?: boolean;
}): Promise<ChatUpdateOutcome> {
  const { run } = await transaction(async tx => ({ run: await loadRun(tx, input.runId, input.sessionId, input.actor.id, false) }));
  const repoRef = repoRefOf(run);
  const outcome = await withRepoLock(repoRef, () => transaction(async (tx): Promise<ChatUpdateOutcome> => {
    const current = await loadRun(tx, input.runId, input.sessionId, input.actor.id, true);
    requireEditor(current);
    if (current.driver_user_id !== input.actor.id || current.control_version !== input.version) {
      throw new ControlError("Only the chat's current driver can update it. Refresh or accept a handoff.");
    }
    requireIdle(current);
    if (current.merge_state === "discarded") throw new ControlError("This parallel chat was discarded. Reopen it before updating.");
    const room = await roomHead(tx, current, false);
    const chat = current.head_sha!;
    if (chat !== input.expectedChatHead || room !== input.expectedRoomHead) {
      throw new ControlError("The chat or the room changed. Refresh and try again.");
    }
    const branch = chatBranchOf(current.id);
    const gitChat = await branchTip(repoRef, branch);
    let updated: string;
    let conflicts: string[] = [];
    if (gitChat !== chat) {
      if (!gitChat || !await producedBy(repoRef, gitChat, chat, room)) throw new ControlError("The chat's branch changed outside this update. Refresh and try again.");
      updated = gitChat;
    } else {
      const result = await mergeCommits(repoRef, chat, room, {
        message: "Update parallel chat from the room", author: { name: input.actor.name, email: input.actor.email },
        allowConflicts: input.allowConflicts,
      });
      if (!result.ok) return result;
      if (result.sha !== chat) await moveBranch(repoRef, branch, result.sha, chat);
      updated = result.sha;
      conflicts = result.conflicts ?? [];
    }
    const base = await mergeBase(repoRef, room, updated) ?? updated;
    const totals = await diffFilesBare(repoRef, base, updated);
    await tx.query(`UPDATE agent_runs SET head_sha = $2, merge_state = 'open', added_lines = $3, removed_lines = $4 WHERE id = $1`,
      [current.id, updated, totals.reduce((sum, file) => sum + file.added, 0), totals.reduce((sum, file) => sum + file.removed, 0)]);
    return { ok: true, sha: updated, changed: updated !== chat, conflicts };
  }));
  if (!outcome.ok) return outcome;
  if (outcome.changed) {
    await announce(run, outcome.conflicts.length
      ? `${input.actor.name} brought in the room's latest changes. These files have conflict markers to resolve before merging:\n${outcome.conflicts.map(path => `· ${path}`).join("\n")}`
      : `${input.actor.name} brought in the room's latest changes (${outcome.sha.slice(0, 8)}).`, { mergeState: "open", headSha: outcome.sha });
  }
  return outcome;
}

/** Set a parallel chat aside, or bring it back. Its branch and history are kept either way. */
export async function setChatDiscarded(input: { runId: string; sessionId: string; actor: Actor; discarded: boolean }): Promise<{ mergeState: MergeState }> {
  const result = await transaction(async tx => {
    const run = await loadRun(tx, input.runId, input.sessionId, input.actor.id, true);
    requireEditor(run);
    const { rows: [room] } = await tx.query<{ owner_id: string }>(`SELECT owner_id FROM sessions WHERE id = $1`, [run.session_id]);
    if (run.driver_user_id !== input.actor.id && room?.owner_id !== input.actor.id) {
      throw new ControlError("Only the chat's driver or the room owner can do this.", 403);
    }
    requireIdle(run);
    const next: MergeState = input.discarded ? "discarded" : (run.merged_sha && run.merged_sha === run.head_sha ? "merged" : "open");
    if (input.discarded && run.merge_state === "merged") throw new ControlError("This chat is already merged.");
    await tx.query(`UPDATE agent_runs SET merge_state = $2 WHERE id = $1`, [run.id, next]);
    return { run, mergeState: next, changed: next !== run.merge_state };
  });
  if (result.changed) {
    await announce(result.run, input.discarded
      ? `${input.actor.name} discarded this chat. Its branch is kept; reopen it to continue.`
      : `${input.actor.name} reopened this chat.`, { mergeState: result.mergeState, headSha: result.run.head_sha! });
  }
  return { mergeState: result.mergeState };
}
