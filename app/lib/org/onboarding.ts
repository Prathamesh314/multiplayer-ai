import { queryOne } from "../db/client";

/**
 * How far one member and their team are with a first shared task, read from
 * what exists rather than from a checklist of its own: it is as durable as the
 * work, needs no migration, and a team that already works together (or joined
 * one that does) is simply done, so it never sees the guide.
 */
export type OrgOnboarding = {
  /** Projects you are a member of. */
  projects: number;
  /** A repository in one of your rooms or projects, so agents have code to work on. */
  codeAdded: boolean;
  /** Active members of the team, you included. */
  members: number;
  /** Invitations sent and not yet accepted, revoked or expired. */
  pendingInvites: number;
  /** Someone else is on one of your projects, so they can open its rooms. */
  projectTeammate: boolean;
  /** AI tasks you finished in this team. */
  myTasks: number;
  /** People in this team who have finished an AI task: two means it is shared work. */
  taskPeople: number;
};

export async function orgOnboarding(orgId: string, userId: string): Promise<OrgOnboarding> {
  const row = await queryOne<{
    projects: string; code_added: boolean; members: string; pending_invites: string;
    project_teammate: boolean; my_tasks: string; task_people: string;
  }>(
    `WITH mine AS (
       SELECT m.project_id FROM project_members m JOIN projects p ON p.id = m.project_id
        WHERE m.org_id = $1 AND m.user_id = $2 AND m.removed_at IS NULL AND p.archived_at IS NULL
     ), rooms AS (
       SELECT s.id FROM sessions s WHERE s.org_id = $1 AND s.deleted_at IS NULL
     )
     SELECT
       (SELECT count(*) FROM mine) AS projects,
       (EXISTS (SELECT 1 FROM sessions s WHERE s.org_id = $1 AND s.owner_id = $2 AND s.deleted_at IS NULL
                  AND (EXISTS (SELECT 1 FROM session_repos sr WHERE sr.session_id = s.id)
                    OR EXISTS (SELECT 1 FROM room_repos r WHERE r.session_id = s.id AND r.seeded_at IS NOT NULL)))
         OR EXISTS (SELECT 1 FROM project_repositories pr JOIN mine ON mine.project_id = pr.project_id WHERE pr.ready)) AS code_added,
       (SELECT count(*) FROM org_members WHERE org_id = $1 AND status = 'active') AS members,
       (SELECT count(*) FROM org_invitations WHERE org_id = $1 AND accepted_at IS NULL AND revoked_at IS NULL AND expires_at > now()) AS pending_invites,
       EXISTS (SELECT 1 FROM project_members m JOIN mine ON mine.project_id = m.project_id
                WHERE m.user_id <> $2 AND m.removed_at IS NULL) AS project_teammate,
       (SELECT count(*) FROM agent_runs r JOIN rooms ON rooms.id = r.session_id WHERE r.started_by = $2 AND r.status = 'completed') AS my_tasks,
       (SELECT count(DISTINCT r.started_by) FROM agent_runs r JOIN rooms ON rooms.id = r.session_id WHERE r.status = 'completed') AS task_people`,
    [orgId, userId],
  );
  return {
    projects: Number(row?.projects ?? 0),
    codeAdded: !!row?.code_added,
    members: Number(row?.members ?? 0),
    pendingInvites: Number(row?.pending_invites ?? 0),
    projectTeammate: !!row?.project_teammate,
    myTasks: Number(row?.my_tasks ?? 0),
    taskPeople: Number(row?.task_people ?? 0),
  };
}
