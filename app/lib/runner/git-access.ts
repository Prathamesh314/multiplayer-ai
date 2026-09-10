/*
 * Authorization for the git smart-HTTP surface (/api/git/[repoRef]/…).
 *
 * A repoRef is the id whose bare repo lives at `repos/<id>.git` — either a
 * session (the room's own repo) or a room_repos row (an imported one). The
 * device token names a user; the user's role in the repo's room decides what
 * git may do: any role reads (upload-pack), write roles push (receive-pack).
 * The same public-or-roster rules as every other surface — this module only
 * maps them onto git's two operations, it grants nothing new.
 */

import { canWrite } from "../session/auth";
import { barePath, isSessionId } from "../session/paths";
import { getRoomRepo } from "../session/roomRepos";
import { getSession } from "../session/store";

export type GitAccess = { bare: string };

/**
 * Resolve a repoRef for one user, or null (unknown ref, no role, or a write
 * without write access — indistinguishable on purpose, so the endpoint cannot
 * be used to probe which ids exist).
 */
export async function resolveGitAccess(
  repoRef: string,
  userId: string,
  write: boolean,
): Promise<GitAccess | null> {
  if (!isSessionId(repoRef)) return null;

  // The room's own repo: the ref is the session id itself.
  const session = await getSession(repoRef, userId);
  if (session) {
    if (!session.myRole) return null;
    if (write && !canWrite(session.myRole)) return null;
    return { bare: barePath(repoRef) };
  }

  // An imported room repo: authorize against the room that holds it.
  const roomRepo = await getRoomRepo(repoRef);
  if (!roomRepo) return null;
  const room = await getSession(roomRepo.sessionId, userId);
  if (!room?.myRole) return null;
  if (write && !canWrite(room.myRole)) return null;
  return { bare: barePath(repoRef) };
}
