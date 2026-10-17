import { cookies } from "next/headers";
import { withApiLimit } from "../../../../../../../../lib/http/api-limit";
import { limitedJson } from "../../../../../../../../lib/http/body";
import {
  integrationAccess,
  integrationFailure,
} from "../../../../../../../../lib/integrations/http";
import { configured } from "../../../../../../../../lib/integrations/config";
import {
  connectProject,
  createOAuthState,
} from "../../../../../../../../lib/integrations/store";
import {
  CHOICE_COOKIE,
  botServer,
  clearChoiceCookie,
  discordInstallUrl,
  discordServers,
  inviteState,
  memberServer,
  memberUserId,
  readChoice,
  revokeMemberToken,
  serverAccess,
} from "../../../../../../../../lib/integrations/discord";
import { IntegrationError } from "../../../../../../../../lib/integrations/types";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
type Context = {
  params: Promise<{ slug: string; projectSlug: string; provider: string }>;
};

/**
 * The Discord servers a member can connect to this project: every server their
 * account is in, not only those they manage. See lib/integrations/discord.ts.
 */
async function handle(request: Request, context: Context) {
  const { slug, projectSlug, provider } = await context.params;
  if (provider !== "discord")
    return Response.json({ error: "Not found." }, { status: 404 });
  const gate = await integrationAccess(slug, projectSlug, true);
  if (gate.response) return gate.response;
  const { project, user } = gate.access!;
  try {
    if (!configured("discord"))
      throw new IntegrationError(
        "Discord needs server setup before it can be connected.",
        503,
      );
    const token = readChoice(
      (await cookies()).get(CHOICE_COOKIE)?.value,
      user.id,
      project.id,
    );
    if (!token)
      return Response.json(
        {
          error: "Sign in with Discord again to see your servers.",
          code: "discord_sign_in",
        },
        { status: 401 },
      );
    if (request.method === "GET")
      return Response.json({ servers: await discordServers(token) });

    const body = (await limitedJson(request, 1024)) as {
      guildId?: unknown;
      action?: unknown;
    } | null;
    const guildId = body?.guildId;
    if (typeof guildId !== "string" || !/^\d{1,25}$/.test(guildId))
      throw new IntegrationError("Choose a Discord server.");
    // Membership comes from the member's own Discord account, never the request.
    const guild = await memberServer(token, guildId);
    if (body?.action === "connect") {
      const server = await botServer(guildId);
      await connectProject(project.id, user.id, "discord", {
        externalId: server.id,
        name: server.name,
        token: "server-bot",
        externalUserId: await memberUserId(token),
      });
      await revokeMemberToken(token);
      return Response.json(
        { ok: true },
        { headers: { "set-cookie": clearChoiceCookie } },
      );
    }
    if (body?.action === "install") {
      if (serverAccess(guild, false) !== "install")
        throw new IntegrationError(
          "Only someone who can manage this server can add the bot. Send a server admin an invite instead.",
          403,
        );
      const state = await createOAuthState(project.id, user.id, "discord");
      return Response.json({ url: discordInstallUrl(state, guildId) });
    }
    if (body?.action === "invite")
      return Response.json({
        url: discordInstallUrl(
          inviteState({ projectId: project.id, userId: user.id, guildId, discordUserId: await memberUserId(token) }),
          guildId,
        ),
      });
    throw new IntegrationError("Unknown action.");
  } catch (error) {
    return integrationFailure(error);
  }
}
export const GET = withApiLimit(
  "/api/orgs/[slug]/projects/[projectSlug]/integrations/[provider]/servers",
  handle,
);
export const POST = withApiLimit(
  "/api/orgs/[slug]/projects/[projectSlug]/integrations/[provider]/servers",
  handle,
);
