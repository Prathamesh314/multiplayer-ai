import { orgDenied, projectAccess } from "../../../../../lib/org/auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** One project, if the caller can access it. */
export async function GET(
  _request: Request,
  context: RouteContext<"/api/orgs/[slug]/projects/[projectSlug]">,
) {
  const { slug, projectSlug } = await context.params;
  const result = await projectAccess(slug, projectSlug);
  const refusal = orgDenied(result);
  if (refusal || !result) return refusal!;

  return Response.json(result.project, { headers: { "cache-control": "no-store" } });
}
