import { withApiLimit } from "../../../../../../../lib/http/api-limit";
import { limitedJson } from "../../../../../../../lib/http/body";
import {
  integrationAccess,
  integrationFailure,
} from "../../../../../../../lib/integrations/http";
import { configured } from "../../../../../../../lib/integrations/config";
import {
  connectionFor,
  createOAuthState,
  disconnectProject,
  selectChannels,
} from "../../../../../../../lib/integrations/store";
import { adapterFor } from "../../../../../../../lib/integrations/providers";
import {
  IntegrationError,
  isProvider,
} from "../../../../../../../lib/integrations/types";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
type Context =
  RouteContext<"/api/orgs/[slug]/projects/[projectSlug]/integrations/[provider]">;
async function handle(request: Request, context: Context) {
  const { slug, projectSlug, provider } = await context.params;
  const gate = await integrationAccess(slug, projectSlug, true);
  if (gate.response) return gate.response;
  if (!isProvider(provider))
    return Response.json({ error: "Unknown provider." }, { status: 404 });
  const { project, user } = gate.access!;
  try {
    if (request.method === "DELETE") {
      await disconnectProject(project.id, user.id, provider);
      return Response.json({ ok: true });
    }
    if (!configured(provider))
      throw new IntegrationError(
        "This provider needs server setup before it can be connected.",
        503,
      );
    if (request.method === "POST") {
      const state = await createOAuthState(project.id, user.id, provider);
      return Response.json({ url: adapterFor(provider).authorize(state) });
    }
    const connection = await connectionFor(project.id, provider);
    if (!connection)
      throw new IntegrationError("Connect this provider first.", 404);
    if (request.method === "GET")
      return Response.json({
        channels: await adapterFor(provider).channels(connection),
        // Discord connections made before the member was recorded list only
        // channels everyone can read; reconnecting includes the member's own.
        publicOnly: provider === "discord" && !connection.external_user_id,
      });
    const body = (await limitedJson(request, 8192)) as {
      channelIds?: unknown;
      shareWithProject?: unknown;
    };
    if (
      !body ||
      !Array.isArray(body.channelIds) ||
      body.channelIds.length > 10 ||
      !body.channelIds.every((id) => typeof id === "string") ||
      body.shareWithProject !== true
    )
      throw new IntegrationError(
        "Select up to 10 channels and confirm sharing with this project.",
      );
    const directory = await adapterFor(provider).channels(connection);
    const channels = body.channelIds.map((id) =>
      directory.find((channel) => channel.id === id),
    );
    if (channels.some((channel) => !channel))
      throw new IntegrationError(
        "A selected channel is no longer available. Refresh the channel list.",
      );
    const blocked = channels.find((channel) => channel?.unavailable);
    if (blocked) throw new IntegrationError(`#${blocked.name}: ${blocked.unavailable}`);
    await selectChannels(
      project.id,
      user.id,
      connection.id,
      channels.filter((channel) => !!channel),
    );
    return Response.json({ ok: true });
  } catch (error) {
    return integrationFailure(error);
  }
}
export const GET = withApiLimit(
  "/api/orgs/[slug]/projects/[projectSlug]/integrations/[provider]",
  handle,
);
export const POST = withApiLimit(
  "/api/orgs/[slug]/projects/[projectSlug]/integrations/[provider]",
  handle,
);
export const PUT = withApiLimit(
  "/api/orgs/[slug]/projects/[projectSlug]/integrations/[provider]",
  handle,
);
export const DELETE = withApiLimit(
  "/api/orgs/[slug]/projects/[projectSlug]/integrations/[provider]",
  handle,
);
