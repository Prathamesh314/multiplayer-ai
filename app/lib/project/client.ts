import { NotSignedIn } from "../session/client";
import type { Session, SessionListResponse } from "../session/types";
import type {
  CreateProjectRequest,
  Project,
  ProjectListResponse,
  ProjectMember,
  ProjectMembersResponse,
  ProjectRole,
} from "./types";

async function readError(response: Response, fallback: string): Promise<string> {
  const body = (await response.json().catch(() => null)) as { error?: string } | null;
  return body?.error ?? fallback;
}

export async function listProjects(orgSlug: string): Promise<Project[]> {
  const response = await fetch(`/api/orgs/${encodeURIComponent(orgSlug)}/projects`, {
    cache: "no-store",
  });
  if (response.status === 401) throw new NotSignedIn();
  if (!response.ok) throw new Error(await readError(response, "Could not load projects."));
  return ((await response.json()) as ProjectListResponse).projects;
}

export async function createProject(orgSlug: string, input: CreateProjectRequest): Promise<Project> {
  const response = await fetch(`/api/orgs/${encodeURIComponent(orgSlug)}/projects`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input),
  });
  if (!response.ok) throw new Error(await readError(response, "Could not create the project."));
  return (await response.json()) as Project;
}

export async function fetchProjectMembers(
  orgSlug: string,
  projectSlug: string,
): Promise<ProjectMember[]> {
  const response = await fetch(
    `/api/orgs/${encodeURIComponent(orgSlug)}/projects/${encodeURIComponent(projectSlug)}/members`,
    { cache: "no-store" },
  );
  if (!response.ok) return [];
  return ((await response.json()) as ProjectMembersResponse).members;
}

export async function addProjectMember(
  orgSlug: string,
  projectSlug: string,
  userId: string,
  role: ProjectRole = "editor",
): Promise<void> {
  const response = await fetch(
    `/api/orgs/${encodeURIComponent(orgSlug)}/projects/${encodeURIComponent(projectSlug)}/members`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ userId, role }),
    },
  );
  if (!response.ok) throw new Error(await readError(response, "Could not add that member."));
}

export async function changeProjectMemberRole(
  orgSlug: string,
  projectSlug: string,
  userId: string,
  role: ProjectRole,
): Promise<void> {
  const response = await fetch(
    `/api/orgs/${encodeURIComponent(orgSlug)}/projects/${encodeURIComponent(projectSlug)}/members/${encodeURIComponent(userId)}`,
    {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ role }),
    },
  );
  if (!response.ok) throw new Error(await readError(response, "Could not change that member's role."));
}

export async function removeProjectMember(
  orgSlug: string,
  projectSlug: string,
  userId: string,
): Promise<void> {
  const response = await fetch(
    `/api/orgs/${encodeURIComponent(orgSlug)}/projects/${encodeURIComponent(projectSlug)}/members/${encodeURIComponent(userId)}`,
    { method: "DELETE" },
  );
  if (!response.ok) throw new Error(await readError(response, "Could not remove that member."));
}

export async function listRooms(orgSlug: string, projectSlug: string): Promise<Session[]> {
  const response = await fetch(
    `/api/orgs/${encodeURIComponent(orgSlug)}/projects/${encodeURIComponent(projectSlug)}/rooms`,
    { cache: "no-store" },
  );
  if (!response.ok) throw new Error(await readError(response, "Could not load rooms."));
  return ((await response.json()) as SessionListResponse).sessions;
}
