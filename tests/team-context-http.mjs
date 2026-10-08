import {clerkFixture,clerkCookie} from "./helpers/clerk-fixture.mjs";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { setTimeout as delay } from "node:timers/promises";
import nextEnv from "@next/env";
import { memoryFixture } from "./helpers/memory-fixture.mjs";
import {
  connectProject,
  selectChannels,
} from "../app/lib/integrations/store.ts";

nextEnv.loadEnvConfig(process.cwd());
const databaseUrl = process.env.DATABASE_URL;
process.env.INTEGRATIONS_ENCRYPTION_KEY = "cd".repeat(32);
const f = await memoryFixture({ postgres: true });
const clerk=await clerkFixture();
let server,
  output = "";
try {
  await f.db.query(
    "UPDATE project_members SET role='manager' WHERE project_id=$1 AND user_id=$2",
    [f.project, f.alice],
  );
  const connection = await connectProject(f.project, f.alice, "slack", {
    externalId: "THTTP",
    name: "HTTP fixture",
    token: "must-never-leak",
  });
  await selectChannels(f.project, f.alice, connection.id, [
    {
      id: "CHTTP",
      name: "engineering",
      url: "https://app.slack.com/client/THTTP/CHTTP",
    },
  ]);
  const cookies = {};
  for (const [name, id] of [
    ["alice", f.alice],
    ["bob", f.bob],
    ["outsider", f.outsider],
  ]) {
    cookies[name] = clerkCookie(await clerk.link(f.db,id));
  }
  const schema = (await f.first("SELECT current_schema() AS name")).name;
  const url = new URL(databaseUrl);
  url.searchParams.set("options", `-c search_path=${schema},public`);
  const port = process.env.TEAM_CONTEXT_TEST_PORT ?? "3193",
    base = `http://127.0.0.1:${port}`,
    secret = "http-fixture-signing-secret";
  server = spawn(
    process.execPath,
    ["node_modules/next/dist/bin/next", "start", "-H", "127.0.0.1", "-p", port],
    {
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...process.env, ...clerk.env,
        DATABASE_URL: url.toString(),
        REDIS_URL: "",
        LOCAL_RUNNERS: "0",
        WEB_CONCURRENCY: "1",
        API_TRUST_PROXY: "0",
        INTEGRATIONS_PUBLIC_URL: "https://fixture.example",
        SLACK_CLIENT_ID: "fixture-client",
        SLACK_CLIENT_SECRET: "fixture-secret",
        SLACK_SIGNING_SECRET: secret,
        DISCORD_BOT_TOKEN: "",
        DISCORD_CLIENT_ID: "",
        DISCORD_CLIENT_SECRET: "",
      },
    },
  );
  server.stdout.on("data", (data) => {
    output += data;
  });
  server.stderr.on("data", (data) => {
    output += data;
  });
  let ready = false;
  for (let i = 0; i < 100; i++) {
    try {
      if (
        (
          await fetch(base + "/health/ready", {
            signal: AbortSignal.timeout(1000),
          })
        ).ok
      ) {
        ready = true;
        break;
      }
    } catch {}
    await delay(100);
  }
  assert.ok(ready, "production server is ready");
  const path = base + "/api/orgs/memory/projects/memory/integrations";
  assert.equal((await fetch(path)).status, 401);
  assert.equal(
    (await fetch(path, { headers: { cookie: cookies.outsider } })).status,
    404,
  );
  const summary = await fetch(path, { headers: { cookie: cookies.bob } });
  assert.equal(summary.status, 200);
  const text = await summary.text();
  assert.ok(!text.includes("must-never-leak"));
  assert.ok(!text.includes("credential"));
  assert.equal(
    (
      await fetch(path + "/slack", {
        method: "POST",
        headers: { cookie: cookies.bob },
      })
    ).status,
    403,
  );
  const start = await fetch(path + "/slack", {
    method: "POST",
    headers: { cookie: cookies.alice },
  });
  assert.equal(start.status, 200);
  const authorization = new URL((await start.json()).url);
  assert.equal(authorization.origin, "https://slack.com");
  assert.equal(
    authorization.searchParams.get("redirect_uri"),
    "https://fixture.example/api/integrations/slack/callback",
  );
  const state = authorization.searchParams.get("state");
  assert.equal(
    (
      await fetch(
        base +
          "/api/integrations/slack/callback?state=" +
          state +
          "&error=access_denied",
        { headers: { cookie: cookies.bob }, redirect: "manual" },
      )
    ).status,
    400,
  );
  assert.equal(
    (
      await fetch(
        base +
          "/api/integrations/slack/callback?state=" +
          state +
          "&error=access_denied",
        { headers: { cookie: cookies.alice }, redirect: "manual" },
      )
    ).status,
    303,
  );
  assert.equal(
    (
      await fetch(
        base +
          "/api/integrations/slack/callback?state=" +
          state +
          "&error=access_denied",
        { headers: { cookie: cookies.alice }, redirect: "manual" },
      )
    ).status,
    400,
  );
  const webhook = async (payload) => {
    const body = JSON.stringify(payload),
      timestamp = String(Math.floor(Date.now() / 1000));
    return fetch(base + "/api/integrations/slack/events", {
      method: "POST",
      body,
      headers: {
        "content-type": "application/json",
        "x-slack-request-timestamp": timestamp,
        "x-slack-signature":
          "v0=" +
          createHmac("sha256", secret)
            .update(`v0:${timestamp}:${body}`)
            .digest("hex"),
      },
    });
  };
  assert.equal(
    (
      await fetch(base + "/api/integrations/slack/events", {
        method: "POST",
        body: "{}",
      })
    ).status,
    401,
  );
  assert.deepEqual(
    await (
      await webhook({
        type: "url_verification",
        challenge: "fixture-challenge",
      })
    ).json(),
    { challenge: "fixture-challenge" },
  );
  const event = {
    type: "event_callback",
    team_id: "THTTP",
    event: {
      type: "message",
      channel: "CHTTP",
      user: "UHTTP",
      ts: (Date.now() / 1000).toFixed(6),
      text: "HTTP event is durable",
    },
  };
  assert.equal((await webhook(event)).status, 200);
  assert.equal((await webhook(event)).status, 200);
  assert.equal(
    (await f.first("SELECT count(*)::int AS n FROM context_messages")).n,
    1,
  );
  assert.equal(
    (
      await fetch(path + "/slack", {
        method: "DELETE",
        headers: { cookie: cookies.bob },
      })
    ).status,
    403,
  );
  assert.equal(
    (
      await fetch(path + "/slack", {
        method: "DELETE",
        headers: { cookie: cookies.alice },
      })
    ).status,
    200,
  );
  assert.equal((await webhook(event)).status, 200);
  assert.equal(
    (await f.first("SELECT count(*)::int AS n FROM context_messages")).n,
    0,
  );
  console.log(
    "PASS: production HTTP auth, manager gates, credential privacy, OAuth state/account binding, signed webhook challenge, durable event deduplication and disconnect.",
  );
} catch (error) {
  console.error(output.slice(-5000));
  throw error;
} finally {
  if (server && server.exitCode === null) {
    server.kill();
    await once(server, "exit");
  }
  await clerk.close();
  await f.close();
}
