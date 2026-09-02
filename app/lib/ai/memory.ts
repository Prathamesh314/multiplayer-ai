import { queryOne } from "../db/client";
import { visibleRoomIds } from "../project/store";
import { listRunMessages, listRunsForRooms } from "./runs";
import type { ForkableRun } from "./runs";

export type { ForkableRun };

/** Candidate source chats for "import context from…": every run in a room this caller can see. */
export async function listForkableRuns(projectId: string, userId: string): Promise<ForkableRun[]> {
  const roomIds = await visibleRoomIds(projectId, userId);
  return listRunsForRooms([...roomIds]);
}

/**
 * Deep-copies a source chat's transcript into the new chat's memory.
 *
 * Only user/agent turns are carried over — system and tool output is
 * operational noise (stderr excerpts, run notices), not context a fresh chat
 * needs. Stores the full transcript regardless of how much of it ends up
 * fitting in the destination run's opening prompt.
 */
export async function forkRunMemory(input: {
  sourceRunId: string;
  destRunId: string;
  createdBy: string;
}): Promise<string> {
  const messages = await listRunMessages(input.sourceRunId);
  const content = messages
    .filter((message) => message.role === "user" || message.role === "agent")
    .map((message) => `[${message.authorName ?? message.role}] ${message.body}`)
    .join("\n\n");

  const row = await queryOne<{ content: string }>(
    `INSERT INTO ai_memories (run_id, forked_from_run_id, content, created_by)
     VALUES ($1, $2, $3, $4)
     RETURNING content`,
    [input.destRunId, input.sourceRunId, content, input.createdBy],
  );
  return row!.content;
}
