// AI tools through the production server: only a project's managers change
// its tools, every member allows them for their own computer, personal tools
// are private, and a computer reports which key names it holds, never values.
import { clerkFixture, clerkCookie } from "./helpers/clerk-fixture.mjs";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { setTimeout as delay } from "node:timers/promises";
import nextEnv from "@next/env";
import { memoryFixture } from "./helpers/memory-fixture.mjs";
import { createPairingCode, exchangePairingCode } from "../app/lib/runner/devices.ts";

nextEnv.loadEnvConfig(process.cwd());
const databaseUrl = process.env.DATABASE_URL;
const f = await memoryFixture({ postgres: true });
const clerk = await clerkFixture();
let server, output = "";
try {
  const cookies = {};
  for (const [name, id] of [["alice", f.alice], ["bob", f.bob], ["outsider", f.outsider]]) cookies[name] = clerkCookie(await clerk.link(f.db, id));
  await f.db.query(`UPDATE project_members SET role = 'manager' WHERE project_id = $1 AND user_id = $2`, [f.project, f.alice]);
  const schema = (await f.first("SELECT current_schema() AS name")).name;
  const url = new URL(databaseUrl);
  url.searchParams.set("options", `-c search_path=${schema},public`);
  const port = process.env.AGENT_TOOLS_TEST_PORT ?? "3198", base = `http://127.0.0.1:${port}`;
  server = spawn(process.execPath, ["node_modules/next/dist/bin/next", "start", "-H", "127.0.0.1", "-p", port], {
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, ...clerk.env, DATABASE_URL: url.toString(), REDIS_URL: "", LOCAL_RUNNERS: "0", WEB_CONCURRENCY: "1", API_TRUST_PROXY: "0" },
  });
  server.stdout.on("data", (data) => { output += data; });
  server.stderr.on("data", (data) => { output += data; });
  let ready = false;
  for (let i = 0; i < 100 && !ready; i++) {
    try { ready = (await fetch(base + "/health/ready", { signal: AbortSignal.timeout(1000) })).ok; } catch { /* starting */ }
    if (!ready) await delay(100);
  }
  assert.ok(ready, "production server is ready");

  const project = `${base}/api/orgs/memory/projects/memory/agent-tools`;
  const call = (cookie, path, method = "GET", body) => fetch(path, { method, headers: { cookie, ...(body ? { "content-type": "application/json" } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const github = { kind: "mcp", name: "github", spec: { transport: "http", url: "https://api.githubcopilot.com/mcp/", headers: [{ name: "Authorization", value: "Bearer ${GITHUB_TOKEN}" }] } };

  assert.equal((await call("", project)).status, 401, "signed out");
  assert.equal((await call(cookies.outsider, project)).status, 404, "not in the project");
  assert.equal((await call(cookies.bob, project, "POST", github)).status, 403, "members cannot add project tools");
  const bad = await call(cookies.alice, project, "POST", { ...github, spec: { ...github.spec, url: "http://example.com" } });
  assert.equal(bad.status, 400);
  assert.match((await bad.json()).error, /https/);
  const created = await call(cookies.alice, project, "POST", github);
  assert.equal(created.status, 201, await created.clone().text());
  const { id } = await created.json();

  const bobs = await (await call(cookies.bob, project)).json();
  assert.equal(bobs.canManage, false);
  assert.deepEqual(bobs.tools.map((tool) => [tool.name, tool.approved, tool.secrets]), [["github", false, ["GITHUB_TOKEN"]]]);
  assert.equal((await call(cookies.bob, `${project}/${id}`, "PATCH", { enabled: false })).status, 403);
  assert.equal((await call(cookies.bob, `${project}/${id}`, "DELETE")).status, 403);
  assert.equal((await call(cookies.bob, `${project}/${id}/approval`, "POST")).status, 200, "any member allows a tool for their own computer");
  assert.equal((await (await call(cookies.bob, project)).json()).tools[0].approved, true);
  assert.equal((await call(cookies.bob, `${project}/00000000-0000-4000-8000-000000000000/approval`, "POST")).status, 404);
  assert.equal((await call(cookies.alice, `${project}/${id}`, "PATCH", { ...github, spec: { ...github.spec, url: "https://example.com/mcp" } })).status, 200);
  assert.equal((await (await call(cookies.bob, project)).json()).tools[0].approved, false, "a changed tool is asked again");

  // Personal tools: private to their owner, and not reachable through a project.
  const mine = await call(cookies.bob, `${base}/api/me/agent-tools`, "POST", { ...github, name: "my-github" });
  assert.equal(mine.status, 201);
  const personal = (await mine.json()).id;
  assert.deepEqual((await (await call(cookies.alice, `${base}/api/me/agent-tools`)).json()).tools, []);
  assert.equal((await call(cookies.alice, `${base}/api/me/agent-tools/${personal}`, "DELETE")).status, 404);
  assert.equal((await call(cookies.alice, `${project}/${personal}`, "DELETE")).status, 404);
  assert.equal((await call(cookies.bob, `${project}/${personal}/approval`, "POST")).status, 404);

  // A computer reports the key names it holds; the page shows what is missing.
  const { code } = await createPairingCode(f.bob);
  const { token } = await exchangePairingCode({ code, name: "Bob's Mac" });
  const heartbeat = await fetch(`${base}/api/runner/heartbeat`, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ version: "2", agentIds: ["claude"], supportsAgentTools: true, secretNames: ["GITHUB_TOKEN", "bad name", "GITHUB_TOKEN"] }) });
  assert.equal(heartbeat.status, 200, await heartbeat.clone().text());
  const after = await (await call(cookies.bob, `${base}/api/me/agent-tools`)).json();
  assert.deepEqual([after.secretNames, after.computersReady], [["GITHUB_TOKEN"], true]);
  assert.deepEqual((await (await call(cookies.alice, project)).json()).secretNames, [], "only your own computers");
  console.log("PASS: managers change project tools, members allow them for their own computer, changes ask again, personal tools stay private, and computers report key names only.");
} catch (error) {
  console.error(output.slice(-5000));
  throw error;
} finally {
  if (server && server.exitCode === null) { server.kill(); await once(server, "exit"); }
  await clerk.close();
  await f.close();
}
