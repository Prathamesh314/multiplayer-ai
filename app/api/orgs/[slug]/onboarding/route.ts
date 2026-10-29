import { withApiLimit } from "../../../../lib/http/api-limit";
import { orgAccess, orgDenied } from "../../../../lib/org/auth";
import { orgOnboarding, type OrgOnboarding } from "../../../../lib/org/onboarding";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export type OrgOnboardingResponse = OrgOnboarding;

/** Your progress towards a first shared task in this team, for the getting-started guide. */
async function handleGET(_request: Request, context: RouteContext<"/api/orgs/[slug]/onboarding">) {
  const { slug } = await context.params;
  const result = await orgAccess(slug);
  const refusal = orgDenied(result);
  if (refusal || !result) return refusal!;

  const progress = await orgOnboarding(result.org.id, result.user.id);
  return Response.json(progress satisfies OrgOnboardingResponse, {
    headers: { "cache-control": "no-store" },
  });
}

export const GET = withApiLimit("/api/orgs/[slug]/onboarding", handleGET);
