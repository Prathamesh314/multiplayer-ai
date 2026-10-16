// Where AI agents run is decided apart from the terminal: turning the hosted
// terminal on must never move agents off members' computers.
import assert from "node:assert/strict";
import { test } from "node:test";
import { serverExecutionAllowed } from "../app/lib/ai/execution.ts";
import { terminalAccess } from "../app/lib/terminal/guard.ts";

const KEYS = ["NODE_ENV", "AGENT_SERVER_EXECUTION", "MULTIPLAYER_AI_TERMINAL", "REDIS_URL", "LOCAL_RUNNERS"];
function withEnv(values, task) {
  const saved = Object.fromEntries(KEYS.map(key => [key, process.env[key]]));
  for (const key of KEYS) delete process.env[key];
  Object.assign(process.env, values);
  try { return task(); } finally {
    for (const key of KEYS) if (saved[key] === undefined) delete process.env[key]; else process.env[key] = saved[key];
  }
}
const from = host => new Request(`http://${host}/api/ai/run`, { headers: { host } });

test("the hosted terminal never moves agents onto the server", () => withEnv({ NODE_ENV: "production", MULTIPLAYER_AI_TERMINAL: "1", REDIS_URL: "redis://redis:6379" }, () => {
  assert.equal(terminalAccess(from("multicode.in")).allowed, true, "the terminal is on");
  assert.equal(serverExecutionAllowed(from("multicode.in")), false, "agents still run on members' computers");
  assert.equal(serverExecutionAllowed(from("localhost:3000")), false);
}));

test("production never runs agents on the server unless an operator opts in", () => {
  withEnv({ NODE_ENV: "production" }, () => assert.equal(serverExecutionAllowed(from("localhost:3000")), false));
  withEnv({ NODE_ENV: "production", AGENT_SERVER_EXECUTION: "1" }, () => assert.equal(serverExecutionAllowed(from("app.example.com")), true));
});

test("development uses runners whenever they can connect", () => {
  withEnv({ NODE_ENV: "development", REDIS_URL: "redis://localhost:6380" }, () => {
    assert.equal(serverExecutionAllowed(from("localhost:3000")), false, "with Redis, a paired runner runs the agent");
  });
  withEnv({ NODE_ENV: "development" }, () => {
    assert.equal(serverExecutionAllowed(from("localhost:3000")), true, "no runner can connect without Redis: the developer's own server runs it");
    assert.equal(serverExecutionAllowed(from("[::1]:3000")), true);
    assert.equal(serverExecutionAllowed(from("192.168.1.20:3000")), false, "only from the developer's own machine");
  });
  withEnv({ NODE_ENV: "development", REDIS_URL: "redis://localhost:6380", LOCAL_RUNNERS: "0" }, () => {
    assert.equal(serverExecutionAllowed(from("localhost:3000")), true, "runners explicitly disabled");
  });
});

test("AGENT_SERVER_EXECUTION=0 forbids server execution everywhere", () => withEnv({ NODE_ENV: "development", AGENT_SERVER_EXECUTION: "0", MULTIPLAYER_AI_TERMINAL: "1" }, () => {
  assert.equal(serverExecutionAllowed(from("localhost:3000")), false);
  assert.equal(terminalAccess(from("localhost:3000")).allowed, true, "and still leaves the terminal alone");
}));
