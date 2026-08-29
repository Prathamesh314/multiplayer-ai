import { orgAccess, orgDenied } from "../../../../lib/org/auth";
import { createProject, listProjectsForUser } from "../../../../lib/project/store";
import type { CreateProjectRequest, ProjectListResponse } from "../../../../lib/project/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Projects in this org the caller can access. */
export async function GET(_request: Request, context: RouteContext<"/api/orgs/[slug]/projects">) {
  const { slug } = await context.params;
  const result = await orgAccess(slug);
  const refusal = orgDenied(result);
  if (refusal || !result) return refusal!;

  const projects = await listProjectsForUser(result.org.id, result.user.id);
  return Response.json({ projects } satisfies ProjectListResponse, {
    headers: { "cache-control": "no-store" },
  });
}

/** Create a project, optionally connected to a GitHub repo. Admins only. */
export async function POST(request: Request, context: RouteContext<"/api/orgs/[slug]/projects">) {
  const { slug } = await context.params;
  const result = await orgAccess(slug);
  const refusal = orgDenied(result);
  if (refusal || !result) return refusal!;

  // Any member of the org can start a project — they become its manager. This
  // is deliberate: funnelling every project through an org admin is the
  // bottleneck we are removing. Org admins still oversee all projects.

  let body: CreateProjectRequest;
  try {
    body = (await request.json()) as CreateProjectRequest;
  } catch {
    return Response.json({ error: "Expected a JSON body." }, { status: 400 });
  }

  const created = await createProject({
    orgId: result.org.id,
    createdBy: result.user.id,
    name: String(body.name ?? ""),
    slug: body.slug,
    source: body.source === "github" ? "github" : "local",
    githubRepo: body.githubRepo?.trim() || null,
    defaultBranch: body.defaultBranch?.trim() || null,
    upstreamUrl: body.upstreamUrl?.trim() || null,
  });
  if (!created.ok) return Response.json({ error: created.error }, { status: 400 });

  return Response.json(created.project, { status: 201 });
}
