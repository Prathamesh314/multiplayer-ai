// A newly paired computer stays "waiting" until its runner's first heartbeat
// reports its AI tools; before this, a message could be sent and then fail.
import assert from "node:assert/strict";
import { test } from "node:test";
import { memoryFixture } from "./helpers/memory-fixture.mjs";
import { createPairingCode, exchangePairingCode, hasOnlineDevice, listDevices } from "../app/lib/runner/devices.ts";
import { POST as heartbeat } from "../app/api/runner/heartbeat/route.ts";

const beat = (token, body) => heartbeat(new Request("http://localhost/api/runner/heartbeat", {
  method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify(body),
}));

test("a paired computer is online only after its first heartbeat reports its tools", async () => {
  const f = await memoryFixture();
  try {
    const { code } = await createPairingCode(f.alice);
    const { device, token } = await exchangePairingCode({ code, name: "Alice's Mac", platform: "darwin", version: "2" });
    assert.equal(device.online, false, "paired, not yet running");
    assert.equal(device.lastSeenAt, null);
    assert.equal(await hasOnlineDevice(f.alice, "claude", undefined, undefined, true), false, "no message can be sent to it yet");

    const response = await beat(token, { version: "2", agentIds: ["claude"], modelCatalog: {} });
    assert.equal(response.status, 200);
    const [listed] = await listDevices(f.alice);
    assert.equal(listed.online, true, "the heartbeat brings it online");
    assert.equal(await hasOnlineDevice(f.alice, "claude", undefined, undefined, true), true, "with its tools, in the same step");

    // An outdated runner is shown as needing an update rather than waiting forever.
    const second = await exchangePairingCode({ code: (await createPairingCode(f.alice)).code, name: "Old laptop", version: "1" });
    assert.equal((await beat(second.token, { version: "1" })).status, 426);
    const old = (await listDevices(f.alice)).find((item) => item.name === "Old laptop");
    assert.deepEqual([old.online, old.version], [true, "1"]);
    assert.equal(await hasOnlineDevice(f.alice, "claude", undefined, undefined, true), true, "only the up-to-date computer takes work");
  } finally {
    await f.close();
  }
});

test("an AI tool installed but signed out is recorded for Set up AI, and never given work", async () => {
  const f = await memoryFixture();
  try {
    const { query } = await import("../app/lib/db/client.ts");
    const { token } = await exchangePairingCode({ code: (await createPairingCode(f.alice)).code, name: "Windows laptop", platform: "win32", version: "2" });
    // A tool cannot be both ready and signed out; unknown tools are dropped.
    assert.equal((await beat(token, { version: "2", agentIds: ["codex"], signedOutAgentIds: ["claude", "codex", "not-a-tool"], modelCatalog: {} })).status, 200);
    const [row] = await query("SELECT agent_ids, signed_out_agent_ids FROM runner_devices WHERE name = 'Windows laptop'");
    assert.deepEqual([row.agent_ids, row.signed_out_agent_ids], [["codex"], ["claude"]]);
    assert.equal(await hasOnlineDevice(f.alice, "claude", undefined, undefined, true), false, "a signed-out tool takes no work");
    assert.equal(await hasOnlineDevice(f.alice, "codex", undefined, undefined, true), true);
    // Signing in moves it across; an older runner that sends no list clears it.
    await beat(token, { version: "2", agentIds: ["codex", "claude"], signedOutAgentIds: [], modelCatalog: {} });
    assert.deepEqual((await query("SELECT signed_out_agent_ids FROM runner_devices WHERE name = 'Windows laptop'"))[0].signed_out_agent_ids, []);
    await beat(token, { version: "2", agentIds: ["codex"], signedOutAgentIds: ["claude"], modelCatalog: {} });
    await beat(token, { version: "2", agentIds: ["codex"], modelCatalog: {} });
    assert.deepEqual((await query("SELECT signed_out_agent_ids FROM runner_devices WHERE name = 'Windows laptop'"))[0].signed_out_agent_ids, []);
  } finally {
    await f.close();
  }
});
