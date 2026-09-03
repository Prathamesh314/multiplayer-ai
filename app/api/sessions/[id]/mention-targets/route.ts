import { listRunsForRooms } from "../../../../lib/ai/runs";
import { access, denied } from "../../../../lib/session/auth";
import { listRoomsInProject } from "../../../../lib/session/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export type MentionChatDTO = { runId: string; title: string };
export type MentionRoomDTO = { sessionId: string; name: string; chats: MentionChatDTO[] };
export type MentionTargetsResponse = { rooms: MentionRoomDTO[] };

/**
 * Every room in this room's project that the caller may see, each with its
 * chats — the data behind the composer's "@" picker. Unlike forkable-runs
 * (which lists only rooms that already have a chat), this includes empty rooms
 * too, so the picker can show the whole project and say "no chats yet".
 * Personal rooms (no project) have nothing to reference.
 */
export async function GET(
  _request: Request,
  context: RouteContext<"/api/sessions/[id]/mention-targets">,
) {
  const { id } = await context.params;
  const result = await access(id);
  const refusal = denied(result);
  if (refusal || !result) return refusal!;

  if (!result.session.projectId) {
    return Response.json({ rooms: [] } satisfies MentionTargetsResponse, {
      headers: { "cache-control": "no-store" },
    });
  }

  const rooms = await listRoomsInProject(result.session.projectId, result.user.id);
  const runs = await listRunsForRooms(
    rooms.map((room) => room.id),
    500,
  );

  const chatsByRoom = new Map<string, MentionChatDTO[]>();
  for (const run of runs) {
    const list = chatsByRoom.get(run.sessionId) ?? [];
    list.push({ runId: run.id, title: run.title ?? `${run.agentId} run` });
    chatsByRoom.set(run.sessionId, list);
  }

  const payload: MentionRoomDTO[] = rooms.map((room) => ({
    sessionId: room.id,
    name: room.name,
    chats: chatsByRoom.get(room.id) ?? [],
  }));

  return Response.json({ rooms: payload } satisfies MentionTargetsResponse, {
    headers: { "cache-control": "no-store" },
  });
}
