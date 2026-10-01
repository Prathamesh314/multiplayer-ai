import { isUniqueViolation, queryOne } from "../db/client";
import type { ProjectRole } from "../project/types";
import { createSession, memberRoomInProject } from "./store";
import type { Session } from "./types";

/**
 * Every project member gets exactly one room, and this is the only place that
 * makes one: named after their handle (renameable later), public, and pinned
 * to distinguish a member's main room in project metadata.
 *
 * Viewers are the exception — a room is a writable workspace, and
 * a read-only role must not own one. They get theirs if they are promoted.
 *
 * Idempotent by construction — the sessions_member_room_key index refuses a
 * second room, so two concurrent calls settle on the same row. Returns null
 * when no room is owed. Creating a room does not create or select a repository.
 */
export async function ensureMemberRoom(
  project: { id: string; orgId: string },
  userId: string,
  projectRole: ProjectRole,
  handle?: string,
): Promise<Session | null> {
  const existing = await memberRoomInProject(project.id, userId);
  if (existing) return existing;

  if (projectRole === "viewer") return null;

  const name =
    handle ??
    (await queryOne<{ handle: string }>(`SELECT handle FROM users WHERE id = $1`, [userId]))
      ?.handle;
  if (!name) return null;

  let session: Session;
  try {
    session = await createSession(userId, name, {
      orgId: project.orgId,
      projectId: project.id,
      pinned: true,
    });
  } catch (cause) {
    // Lost the race to a concurrent ensure — the winner's room is the room.
    if (isUniqueViolation(cause, "sessions_member_room_key")) {
      return memberRoomInProject(project.id, userId);
    }
    throw cause;
  }

  return session;
}
