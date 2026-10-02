import { withApiLimit } from "../../../../../../lib/http/api-limit";
import {
  integrationAccess,
  integrationFailure,
} from "../../../../../../lib/integrations/http";
import { configured } from "../../../../../../lib/integrations/config";
import { connectionSummary } from "../../../../../../lib/integrations/store";
import { providers } from "../../../../../../lib/integrations/types";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
async function handleGET(
  _request: Request,
  context: RouteContext<"/api/orgs/[slug]/projects/[projectSlug]/integrations">,
) {
  const { slug, projectSlug } = await context.params;
  const gate = await integrationAccess(slug, projectSlug);
  if (gate.response) return gate.response;
  try {
    return Response.json({
      connections: await connectionSummary(gate.access!.project.id),
      providers: providers.map((id) => ({ id, configured: configured(id) })),
      canManage:
        gate.access!.role === "manager" && !gate.access!.project.archivedAt,
    });
  } catch (error) {
    return integrationFailure(error);
  }
}
export const GET = withApiLimit(
  "/api/orgs/[slug]/projects/[projectSlug]/integrations",
  handleGET,
);
