import { callbackUrl, seal, unseal } from "./config";
import { DISCORD_READ, providerJson } from "./providers";
import { IntegrationError } from "./types";

/*
 * Choosing a Discord server.
 *
 * Reading a server needs the app's bot in it, and Discord only lets someone
 * with Manage Server add a bot. So instead of starting with the bot install
 * (whose picker lists only servers you manage), a member signs in with
 * `identify guilds`, which lists every server their account is in. Each one is:
 *
 *   ready   - the bot is already there (an admin added it): connect directly;
 *   install - you can manage it: add the bot, then connect;
 *   ask     - neither: send an admin a signed invite. When they add the bot,
 *             the server connects to the project that asked for it.
 *
 * The member's own token is kept only for the few minutes it takes to choose,
 * sealed in an HttpOnly cookie, and revoked once a server is connected. It is
 * never used to read messages: only the bot reads, and only public channels.
 */

const API = "https://discord.com/api/v10";
const MANAGE_GUILD = 1n << 5n;
const ADMINISTRATOR = 1n << 3n;
const PICK_COOKIE = "discord_servers";
const PICK_TTL_SECONDS = 600;
const INVITE_PREFIX = "invite.";
const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export type DiscordAccess = "ready" | "install" | "ask";
export type DiscordServer = { id: string; name: string; access: DiscordAccess };
type MemberGuild = { id: string; name: string; owner?: boolean; permissions?: string };
export type DiscordGrant = { access_token?: string; scope?: string; guild?: { id: string; name: string } };

const botHeaders = () => ({ authorization: `Bot ${process.env.DISCORD_BOT_TOKEN}` });
const appCredentials = () => ({
  client_id: process.env.DISCORD_CLIENT_ID!,
  client_secret: process.env.DISCORD_CLIENT_SECRET!,
});

/** Sign in as the member, to list the servers their account is in. */
export function discordSignInUrl(state: string) {
  return `https://discord.com/oauth2/authorize?${new URLSearchParams({
    client_id: process.env.DISCORD_CLIENT_ID!,
    scope: "identify guilds",
    response_type: "code",
    redirect_uri: callbackUrl("discord"),
    state,
  })}`;
}

/** Add the bot to one server, preselected; the person approving must manage it. */
export function discordInstallUrl(state: string, guildId: string) {
  return `https://discord.com/oauth2/authorize?${new URLSearchParams({
    client_id: process.env.DISCORD_CLIENT_ID!,
    scope: "bot identify",
    permissions: DISCORD_READ.toString(),
    response_type: "code",
    integration_type: "0",
    redirect_uri: callbackUrl("discord"),
    guild_id: guildId,
    disable_guild_select: "true",
    state,
  })}`;
}

/** One code exchange serves both flows: a bot install's grant names its server. */
export function exchangeDiscordCode(code: string) {
  return providerJson<DiscordGrant>(`${API}/oauth2/token`, {
    method: "POST",
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: callbackUrl("discord"),
      ...appCredentials(),
    }),
  });
}

/** The member's token from a sign-in grant, which must include their server list. */
export function memberToken(grant: DiscordGrant) {
  if (!grant.access_token || !grant.scope?.split(" ").includes("guilds"))
    throw new IntegrationError("Discord did not share your server list. Connect Discord again and allow it.");
  return grant.access_token;
}

/** The member's Discord user ID (`identify`), so channels are offered as they can see them. */
export async function memberUserId(token: string): Promise<string | undefined> {
  const user = await providerJson<{ id?: string }>(`${API}/users/@me`, { headers: { authorization: `Bearer ${token}` } }).catch(() => null);
  return user?.id && /^[0-9]{1,25}$/.test(user.id) ? user.id : undefined;
}

/** Best effort: the token is no longer needed once a server is chosen. */
export async function revokeMemberToken(token: string) {
  await fetch(`${API}/oauth2/token/revoke`, {
    method: "POST",
    body: new URLSearchParams({ token, token_type_hint: "access_token", ...appCredentials() }),
    signal: AbortSignal.timeout(5_000),
  }).catch(() => {});
}

export function serverAccess(guild: MemberGuild, botIsThere: boolean): DiscordAccess {
  if (botIsThere) return "ready";
  const permissions = BigInt(guild.permissions ?? "0");
  return guild.owner || (permissions & (MANAGE_GUILD | ADMINISTRATOR)) !== 0n ? "install" : "ask";
}

const memberGuilds = (token: string) =>
  // A Discord account is in at most 200 servers, so one page is all of them.
  providerJson<MemberGuild[]>(`${API}/users/@me/guilds?limit=200`, {
    headers: { authorization: `Bearer ${token}` },
  });

async function botGuildIds() {
  const ids = new Set<string>();
  let after = "0";
  for (let page = 0; page < 50; page += 1) {
    const batch = await providerJson<{ id: string }[]>(`${API}/users/@me/guilds?limit=200&after=${after}`, { headers: botHeaders() });
    for (const guild of batch) ids.add(guild.id);
    if (batch.length < 200) break;
    after = batch[batch.length - 1].id;
  }
  return ids;
}

const order: Record<DiscordAccess, number> = { ready: 0, install: 1, ask: 2 };

/** Every server the member's account is in, and how each can be connected. */
export async function discordServers(token: string): Promise<DiscordServer[]> {
  const [guilds, bot] = await Promise.all([memberGuilds(token), botGuildIds()]);
  return guilds
    .map((guild) => ({ id: guild.id, name: guild.name, access: serverAccess(guild, bot.has(guild.id)) }))
    .sort((a, b) => order[a.access] - order[b.access] || a.name.localeCompare(b.name));
}

/** A server the member is in, from their own account: never a browser-supplied claim. */
export async function memberServer(token: string, guildId: string) {
  const guild = (await memberGuilds(token)).find((item) => item.id === guildId);
  if (!guild) throw new IntegrationError("Your Discord account is not in that server.", 403);
  return guild;
}

/** The server as the bot sees it; fails when the bot has not been added. */
export async function botServer(guildId: string) {
  try {
    return await providerJson<{ id: string; name: string }>(`${API}/guilds/${encodeURIComponent(guildId)}`, { headers: botHeaders() });
  } catch (error) {
    if (error instanceof IntegrationError && error.status === 403)
      throw new IntegrationError("The bot is not in that server yet. Add it, or ask a server admin to.", 409);
    throw error;
  }
}

const pickScope = (userId: string, projectId: string) => `discord-pick:${userId}:${projectId}`;
const cookieAttributes = "Path=/api/orgs; HttpOnly; Secure; SameSite=Lax";

/** Keeps the member's token for choosing a server in this project, briefly. */
export function choiceCookie(token: string, userId: string, projectId: string) {
  const value = seal(JSON.stringify({ token, expires: Date.now() + PICK_TTL_SECONDS * 1000 }), pickScope(userId, projectId));
  return `${PICK_COOKIE}=${value}; Max-Age=${PICK_TTL_SECONDS}; ${cookieAttributes}`;
}
export const clearChoiceCookie = `${PICK_COOKIE}=; Max-Age=0; ${cookieAttributes}`;
export const CHOICE_COOKIE = PICK_COOKIE;

/** The member's token, or null when the choice expired or belongs to someone else. */
export function readChoice(value: string | undefined, userId: string, projectId: string) {
  if (!value) return null;
  try {
    const choice = JSON.parse(unseal(value, pickScope(userId, projectId))) as { token?: unknown; expires?: unknown };
    return typeof choice.token === "string" && typeof choice.expires === "number" && choice.expires > Date.now() ? choice.token : null;
  } catch {
    return null;
  }
}

export type DiscordInvite = { projectId: string; userId: string; guildId: string;
  /** The requesting member's Discord user ID, when known. */
  discordUserId?: string };

/** OAuth state for an admin's bot install, made for one project and server. */
export function inviteState(invite: DiscordInvite) {
  return INVITE_PREFIX + seal(JSON.stringify({ ...invite, expires: Date.now() + INVITE_TTL_MS }), "discord-invite");
}
export const isInviteState = (state: string) => state.startsWith(INVITE_PREFIX);
export function readInvite(state: string): DiscordInvite | null {
  if (!isInviteState(state) || state.length > 1024) return null;
  try {
    const invite = JSON.parse(unseal(state.slice(INVITE_PREFIX.length), "discord-invite")) as Record<string, unknown>;
    const { projectId, userId, guildId, expires, discordUserId } = invite;
    if (typeof projectId !== "string" || typeof userId !== "string" || typeof guildId !== "string") return null;
    if (typeof expires !== "number" || expires <= Date.now()) return null;
    return { projectId, userId, guildId, ...(typeof discordUserId === "string" && /^[0-9]{1,25}$/.test(discordUserId) ? { discordUserId } : {}) };
  } catch {
    return null;
  }
}
