import { orgAccess, orgDenied } from "../../../lib/org/auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** One org, if the caller belongs to it. */
export async function GET(_request: Request, context: RouteContext<"/api/orgs/[slug]">) {
  const { slug } = await context.params;
  const result = await orgAccess(slug);
  const refusal = orgDenied(result);
  if (refusal || !result) return refusal!;

  return Response.json(result.org, { headers: { "cache-control": "no-store" } });
}
