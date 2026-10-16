import { withApiLimit } from "../../../../lib/http/api-limit";
import { currentUser } from "../../../../lib/auth/tokens";
import {
  consumeOAuthState,
  connectProject,
  connectionFor,
} from "../../../../lib/integrations/store";
import {
  botServer,
  choiceCookie,
  exchangeDiscordCode,
  isInviteState,
  memberToken,
  readInvite,
} from "../../../../lib/integrations/discord";
import { adapterFor } from "../../../../lib/integrations/providers";
import {
  configured,
  integrationOrigin,
} from "../../../../lib/integrations/config";
import { IntegrationError, isProvider } from "../../../../lib/integrations/types";
import { integrationFailure } from "../../../../lib/integrations/http";
import { queryOne } from "../../../../lib/db/client";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
async function handleGET(
  request: Request,
  context: RouteContext<"/api/integrations/[provider]/callback">,
) {
  const { provider } = await context.params;
  if (!isProvider(provider) || !configured(provider))
    return Response.json(
      { error: "This provider is not configured." },
      { status: 503 },
    );
  const state = new URL(request.url).searchParams.get("state") ?? "";
  // A server admin adding the bot from a member's invite: they need no
  // account here, because the signed state says which project asked.
  if (provider === "discord" && isInviteState(state))
    return discordInvite(new URL(request.url), state);
  const user = await currentUser();
  if (!user)
    return Response.json(
      {
        error:
          "Sign in to the app in this browser, then start the connection again.",
      },
      { status: 401 },
    );
  const url = new URL(request.url);
  try {
    const project = await consumeOAuthState(state, user.id, provider);
    if (url.searchParams.has("error"))
      return Response.redirect(
        `${integrationOrigin()}/workspace?connection=cancelled`,
        303,
      );
    const code = url.searchParams.get("code");
    if (!code || code.length > 2048)
      return Response.json(
        { error: "Missing authorization code. Start the connection again." },
        { status: 400 },
      );
    const organisation = await queryOne<{ slug: string }>(
      "SELECT o.slug FROM projects p JOIN orgs o ON o.id=p.org_id WHERE p.id=$1",
      [project],
    );
    const back = (extra: Record<string, string>) =>
      `${integrationOrigin()}/workspace?${new URLSearchParams({ connections: project, org: organisation?.slug ?? "", ...extra })}`;
    let source;
    if (provider === "discord") {
      const grant = await exchangeDiscordCode(code);
      // A sign-in lists the member's servers to choose from; a bot install
      // (started from that list) names the one server it was added to.
      if (!grant.guild)
        return new Response(null, {
          status: 303,
          headers: {
            location: back({ discord: "choose" }),
            "set-cookie": choiceCookie(memberToken(grant), user.id, project),
          },
        });
      const server = await botServer(grant.guild.id);
      source = { externalId: server.id, name: server.name, token: "server-bot" };
    } else source = await adapterFor(provider).exchange(code);
    await connectProject(project, user.id, provider, source);
    return Response.redirect(back({ connected: provider }), 303);
  } catch (error) {
    return integrationFailure(error);
  }
}
/** A short page for the admin, who may have no account or workspace here. */
function notice(message: string, status = 200) {
  const text = message.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
  return new Response(
    `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Discord</title><body style="font:15px/1.5 system-ui,sans-serif;max-width:32rem;margin:15vh auto;padding:0 16px"><p>${text}</p></body>`,
    { status, headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } },
  );
}

async function discordInvite(url: URL, state: string) {
  const invite = readInvite(state);
  if (!invite) return notice("This invite link is invalid or has expired. Ask your teammate for a new one.", 400);
  if (url.searchParams.has("error")) return notice("The bot was not added. You can close this tab.");
  const code = url.searchParams.get("code");
  if (!code || code.length > 2048) return notice("Discord did not complete the request. Open the invite link again.", 400);
  try {
    const grant = await exchangeDiscordCode(code);
    if (grant.guild?.id !== invite.guildId)
      return notice("The bot was added to a different server than the one this link is for, so nothing was connected.", 409);
    const server = await botServer(invite.guildId);
    // The link can be opened again; that must not reset chosen channels.
    if ((await connectionFor(invite.projectId, "discord"))?.external_id !== server.id)
      await connectProject(invite.projectId, invite.userId, "discord", { externalId: server.id, name: server.name, token: "server-bot" });
    return notice(`Done. The bot was added to ${server.name}, and your teammate can now choose its channels. You can close this tab.`);
  } catch (error) {
    return notice(error instanceof IntegrationError ? error.message : "Could not finish connecting. Try the invite link again.", 502);
  }
}

export const GET = withApiLimit(
  "/api/integrations/[provider]/callback",
  handleGET,
);
