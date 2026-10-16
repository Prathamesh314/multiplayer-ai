// Choosing any Discord server the member's account is in, not only the ones
// they manage: sign-in scopes, how each server can be connected, the short-lived
// choice cookie, signed admin invites, and the invite callback end to end.
import assert from "node:assert/strict";
import { test } from "node:test";
import { memoryFixture } from "./helpers/memory-fixture.mjs";
import {
  botServer,
  choiceCookie,
  discordInstallUrl,
  discordServers,
  discordSignInUrl,
  inviteState,
  memberServer,
  memberToken,
  readChoice,
  readInvite,
  serverAccess,
} from "../app/lib/integrations/discord.ts";
import { connectionFor, selectChannels } from "../app/lib/integrations/store.ts";
import { seal } from "../app/lib/integrations/config.ts";

Object.assign(process.env, {
  INTEGRATIONS_ENCRYPTION_KEY: "cd".repeat(32),
  INTEGRATIONS_PUBLIC_URL: "https://app.example.test",
  DISCORD_CLIENT_ID: "client-id",
  DISCORD_CLIENT_SECRET: "client-secret",
  DISCORD_BOT_TOKEN: "bot-token",
});

const MANAGE_GUILD = String(1 << 5), ADMINISTRATOR = String(1 << 3), SEND = String(1 << 11);
const realFetch = globalThis.fetch;
/** Discord, faked: `routes` maps "METHOD /path" to a JSON body, a function of the URL, or a status. */
function fakeDiscord(routes) {
  const calls = [];
  globalThis.fetch = async (input, init = {}) => {
    const url = new URL(String(input));
    const route = `${init.method ?? "GET"} ${url.pathname.replace("/api/v10", "")}`;
    calls.push({ key: `${route}${url.search}`, auth: new Headers(init.headers).get("authorization") });
    if (!(route in routes)) return new Response("{}", { status: 404 });
    const value = routes[route];
    return typeof value === "number" ? new Response("{}", { status: value }) : Response.json(typeof value === "function" ? value(url) : value);
  };
  return calls;
}
test.afterEach(() => { globalThis.fetch = realFetch; });

test("connecting signs in to list servers; only the bot install asks for the bot", () => {
  const signIn = new URL(discordSignInUrl("state-1"));
  assert.equal(signIn.searchParams.get("scope"), "identify guilds");
  assert.equal(signIn.searchParams.get("permissions"), null);
  assert.equal(signIn.searchParams.get("redirect_uri"), "https://app.example.test/api/integrations/discord/callback");
  const install = new URL(discordInstallUrl("state-2", "42"));
  assert.equal(install.searchParams.get("scope"), "bot identify");
  assert.equal(install.searchParams.get("guild_id"), "42");
  assert.equal(install.searchParams.get("disable_guild_select"), "true");
  assert.equal(install.searchParams.get("permissions"), String(1024 | 65536), "View Channel and Read Message History only");
});

test("each server is ready, installable by its managers, or needs an admin", () => {
  assert.equal(serverAccess({ id: "1", name: "a", permissions: SEND }, true), "ready", "any member connects once the bot is there");
  assert.equal(serverAccess({ id: "1", name: "a", owner: true, permissions: "0" }, false), "install");
  assert.equal(serverAccess({ id: "1", name: "a", permissions: MANAGE_GUILD }, false), "install");
  assert.equal(serverAccess({ id: "1", name: "a", permissions: ADMINISTRATOR }, false), "install");
  assert.equal(serverAccess({ id: "1", name: "a", permissions: SEND }, false), "ask");
});

test("the list has every server the account is in, with the bot found across pages", async () => {
  const botPage = Array.from({ length: 200 }, (_, index) => ({ id: String(1000 + index) }));
  const calls = fakeDiscord({
    "GET /users/@me/guilds": (url) => url.searchParams.has("after")
      ? (url.searchParams.get("after") === "0" ? botPage : [{ id: "7" }])
      : [
          { id: "5", name: "Zeta (member)", permissions: SEND },
          { id: "7", name: "Gamma (bot on page 2)", permissions: SEND },
          { id: "9", name: "Alpha (owned)", owner: true, permissions: "0" },
          { id: "1003", name: "Beta (bot on page 1)", permissions: SEND },
        ],
  });
  const servers = await discordServers("member-token");
  assert.deepEqual(servers.map((server) => [server.name, server.access]), [
    ["Beta (bot on page 1)", "ready"],
    ["Gamma (bot on page 2)", "ready"],
    ["Alpha (owned)", "install"],
    ["Zeta (member)", "ask"],
  ]);
  const member = calls.filter((call) => call.auth === "Bearer member-token");
  const bot = calls.filter((call) => call.auth === "Bot bot-token");
  assert.equal(member.length, 1, "the member's token only lists their servers");
  assert.deepEqual(bot.map((call) => call.key), ["GET /users/@me/guilds?limit=200&after=0", "GET /users/@me/guilds?limit=200&after=1199"]);
});

test("membership comes from the account, and a missing bot is explained", async () => {
  fakeDiscord({ "GET /users/@me/guilds": [{ id: "5", name: "Mine", permissions: SEND }], "GET /guilds/6": 403 });
  assert.equal((await memberServer("t", "5")).name, "Mine");
  await assert.rejects(memberServer("t", "6"), (error) => error.status === 403 && /not in that server/.test(error.message));
  await assert.rejects(botServer("6"), (error) => error.status === 409 && /bot is not in that server/.test(error.message));
});

test("a sign-in grant must include the server list", () => {
  assert.equal(memberToken({ access_token: "t", scope: "identify guilds" }), "t");
  assert.throws(() => memberToken({ access_token: "t", scope: "identify" }), /server list/);
  assert.throws(() => memberToken({ scope: "identify guilds" }), /server list/);
});

test("the choice cookie is HttpOnly, short-lived and bound to one member and project", () => {
  const header = choiceCookie("member-token", "alice", "project-1");
  assert.match(header, /^discord_servers=[^;]+; Max-Age=600; Path=\/api\/orgs; HttpOnly; Secure; SameSite=Lax$/);
  const value = header.slice("discord_servers=".length, header.indexOf(";"));
  assert.equal(readChoice(value, "alice", "project-1"), "member-token");
  assert.equal(readChoice(value, "bob", "project-1"), null, "another member");
  assert.equal(readChoice(value, "alice", "project-2"), null, "another project");
  const flipped = value.slice(0, 20) + (value[20] === "A" ? "B" : "A") + value.slice(21);
  assert.equal(readChoice(flipped, "alice", "project-1"), null, "tampered");
  assert.equal(readChoice(undefined, "alice", "project-1"), null);
  const expired = seal(JSON.stringify({ token: "t", expires: Date.now() - 1 }), "discord-pick:alice:project-1");
  assert.equal(readChoice(expired, "alice", "project-1"), null, "expired");
});

test("admin invites are signed for one project, member and server, and expire", () => {
  const invite = { projectId: "p", userId: "u", guildId: "42" };
  const state = inviteState(invite);
  assert.ok(state.startsWith("invite."));
  assert.deepEqual(readInvite(state), invite);
  const tampered = state.slice(0, 30) + (state[30] === "A" ? "B" : "A") + state.slice(31);
  assert.equal(readInvite(tampered), null, "tampered");
  assert.equal(readInvite(state.slice("invite.".length)), null, "not an invite");
  const old = `invite.${seal(JSON.stringify({ ...invite, expires: Date.now() - 1 }), "discord-invite")}`;
  assert.equal(readInvite(old), null, "expired");
});

test("an admin's invite connects the server to the project that asked, once", async () => {
  const f = await memoryFixture();
  try {
    await f.db.query("UPDATE project_members SET role='manager' WHERE project_id=$1 AND user_id=$2", [f.project, f.alice]);
    const { GET } = await import("../app/api/integrations/[provider]/callback/route.ts");
    const call = (state, extra = "code=abc") => GET(
      new Request(`https://app.example.test/api/integrations/discord/callback?${extra}&state=${encodeURIComponent(state)}`),
      { params: Promise.resolve({ provider: "discord" }) },
    );
    const state = inviteState({ projectId: f.project, userId: f.alice, guildId: "42" });
    fakeDiscord({ "POST /oauth2/token": { access_token: "x", scope: "bot identify", guild: { id: "43", name: "Other" } }, "GET /guilds/42": { id: "42", name: "Team server" } });
    const wrong = await call(state);
    assert.equal(wrong.status, 409, "a different server connects nothing");
    assert.equal(await connectionFor(f.project, "discord"), null);

    fakeDiscord({ "POST /oauth2/token": { access_token: "x", scope: "bot identify", guild: { id: "42", name: "Team server" } }, "GET /guilds/42": { id: "42", name: "Team server" } });
    const done = await call(state);
    assert.equal(done.status, 200);
    assert.match(await done.text(), /Team server/);
    const connection = await connectionFor(f.project, "discord");
    assert.equal(connection.external_id, "42");
    assert.equal(connection.created_by, f.alice, "connected for the member who asked");
    await selectChannels(f.project, f.alice, connection.id, [{ id: "c1", name: "general", url: "https://discord.com/channels/42/c1" }]);
    await call(state);
    assert.equal((await connectionFor(f.project, "discord")).id, connection.id, "opening the link again keeps the chosen channels");

    assert.equal((await call(state.slice(0, 30) + (state[30] === "A" ? "B" : "A") + state.slice(31))).status, 400, "tampered");
    assert.match(await (await call(state, "error=access_denied")).text(), /not added/);
    await f.db.query("UPDATE project_members SET role='editor' WHERE project_id=$1 AND user_id=$2", [f.project, f.alice]);
    await f.db.query("DELETE FROM context_connections WHERE project_id=$1", [f.project]);
    const revoked = await call(state);
    assert.equal(revoked.status, 502);
    assert.match(await revoked.text(), /manager/);
    assert.equal(await connectionFor(f.project, "discord"), null, "a member who lost manager access connects nothing");
  } finally {
    await f.close();
  }
});
