/**
 * One suite, run against both presence drivers.
 *
 * The in-process driver is what development uses and Redis is what production
 * uses, so the risk worth testing is the two of them disagreeing. Everything
 * here runs against both, on a fake clock so the TTL window can be crossed
 * without waiting.
 *
 * Run with `npm run test:presence` — it compiles the TypeScript first.
 */
const assert = require("node:assert/strict");
const { createMemoryPresence } = require("../.test-build/memory.js");
const { createRedisPresence } = require("../.test-build/redis.js");
const { TTL_MS } = require("../.test-build/types.js");

let passed = 0;
let failed = 0;

/** Redis with real sorted-set semantics, so the driver's commands are exercised. */
function fakeRedis() {
  const hashes = new Map();
  const zsets = new Map();

  const z = (key) => {
    if (!zsets.has(key)) zsets.set(key, new Map());
    return zsets.get(key);
  };

  // Redis score bounds: "(123" is exclusive, "+inf" unbounded.
  const bound = (raw) => {
    const text = String(raw);
    if (text === "+inf") return { value: Infinity, exclusive: false };
    if (text.startsWith("(")) return { value: Number(text.slice(1)), exclusive: true };
    return { value: Number(text), exclusive: false };
  };

  const within = (score, min, max) =>
    (min.exclusive ? score > min.value : score >= min.value) &&
    (max.exclusive ? score < max.value : score <= max.value);

  return {
    async hSet(key, value) {
      hashes.set(key, { ...(hashes.get(key) ?? {}), ...value });
    },
    async expire() {},
    async hGetAll(key) {
      return hashes.get(key) ?? {};
    },
    async del(key) {
      hashes.delete(key);
    },
    async zAdd(key, { score, value }) {
      z(key).set(value, score);
    },
    async zRem(key, member) {
      z(key).delete(member);
    },
    async zRangeByScore(key, min, max) {
      const lo = bound(min);
      const hi = bound(max);
      return [...z(key).entries()]
        .filter(([, score]) => within(score, lo, hi))
        .sort((a, b) => a[1] - b[1])
        .map(([member]) => member);
    },
    async zRemRangeByScore(key, min, max) {
      const lo = bound(min);
      const hi = bound(max);
      for (const [member, score] of [...z(key).entries()]) {
        if (within(score, lo, hi)) z(key).delete(member);
      }
    },
    async quit() {},
  };
}

async function test(driver, name, fn) {
  try {
    await fn();
    console.log(`  ok   [${driver}] ${name}`);
    passed += 1;
  } catch (cause) {
    console.log(`  FAIL [${driver}] ${name}\n       ${cause.message.split("\n")[0]}`);
    failed += 1;
  }
}

/**
 * With REDIS_URL set, the suite also runs against the real server. The clock
 * stays injectable, so the 45-second TTL window is still crossed instantly —
 * scores are just numbers to Redis.
 *
 * Database 1, flushed first, so a dev machine's real presence data is untouched.
 */
async function realRedis() {
  if (!process.env.REDIS_URL) return null;
  const { createClient } = require("redis");
  const url = new URL(process.env.REDIS_URL);
  url.pathname = "/1";
  const client = createClient({ url: url.toString() });
  await client.connect();
  await client.flushDb();
  return client;
}

async function main() {
  console.log("\npresence drivers\n");

  const live = await realRedis();
  const drivers = [
    ["memory", (clock) => createMemoryPresence(clock)],
    ["fake  ", (clock) => createRedisPresence(fakeRedis(), clock)],
    ...(live ? [["redis ", (clock) => createRedisPresence(live, clock)]] : []),
  ];

  if (!live) console.log("  (REDIS_URL unset — skipping the real server)\n");

  for (const [label, make] of drivers) {
    let t = 1_000_000;
    const clock = () => t;
    const p = make(clock);

    const alice = { userId: "u-alice", sessionId: "s-1", orgId: "o-1" };
    const bob = { userId: "u-bob", sessionId: "s-2", orgId: "o-1" };

    await test(label, "a heartbeat puts someone in their session", async () => {
      await p.heartbeat("c-alice-1", alice);
      assert.deepEqual(await p.onlineInSession("s-1"), ["u-alice"]);
      assert.equal(await p.isOnline("u-alice"), true);
    });

    await test(label, "the org set spans separate sessions", async () => {
      await p.heartbeat("c-bob-1", bob);
      assert.deepEqual((await p.onlineInOrg("o-1")).sort(), ["u-alice", "u-bob"]);
      assert.deepEqual(await p.onlineInSession("s-2"), ["u-bob"]);
    });

    await test(label, "a second tab does not duplicate the person", async () => {
      await p.heartbeat("c-alice-2", alice);
      assert.deepEqual(await p.onlineInSession("s-1"), ["u-alice"]);
    });

    await test(label, "closing one of two tabs keeps them online", async () => {
      await p.disconnect("c-alice-1");
      assert.equal(await p.isOnline("u-alice"), true);
      assert.deepEqual(await p.onlineInSession("s-1"), ["u-alice"]);
    });

    await test(label, "closing the last tab marks them away", async () => {
      await p.disconnect("c-alice-2");
      assert.equal(await p.isOnline("u-alice"), false);
      assert.deepEqual(await p.onlineInSession("s-1"), []);
    });

    await test(label, "a silent connection expires without any disconnect", async () => {
      // Bob is still connected, and never says goodbye.
      assert.deepEqual(await p.onlineInSession("s-2"), ["u-bob"]);
      t += TTL_MS + 1;
      assert.deepEqual(await p.onlineInSession("s-2"), []);
      assert.deepEqual(await p.onlineInOrg("o-1"), []);
      assert.equal(await p.isOnline("u-bob"), false);
    });

    await test(label, "a heartbeat inside the window keeps them alive", async () => {
      await p.heartbeat("c-bob-2", bob);
      t += TTL_MS - 1000;
      await p.heartbeat("c-bob-2", bob);
      t += TTL_MS - 1000;
      assert.deepEqual(await p.onlineInSession("s-2"), ["u-bob"]);
    });

    await test(label, "a chat's viewers follow the tab that has it open", async () => {
      const room = { sessionId: "s-run", orgId: "o-run" };
      const first = await p.heartbeat("c-ann-1", { userId: "u-ann", ...room, runId: "r-1" });
      assert.deepEqual([first.changed, first.sessionIds], [true, ["s-run"]], "a new viewer is news for the room");
      assert.deepEqual((await p.heartbeat("c-ann-1", { userId: "u-ann", ...room, runId: "r-1" })).changed, false, "a repeat beat is not");
      await p.heartbeat("c-cal-1", { userId: "u-cal", ...room, runId: "r-1" });
      assert.deepEqual((await p.onlineInRun("r-1")).sort(), ["u-ann", "u-cal"]);
      // Switching chats leaves the old one at once, without waiting for the TTL.
      assert.equal((await p.heartbeat("c-ann-1", { userId: "u-ann", ...room, runId: "r-2" })).changed, true);
      assert.deepEqual(await p.onlineInRun("r-1"), ["u-cal"]);
      assert.deepEqual(await p.onlineInRun("r-2"), ["u-ann"]);
      // Another tab still on the chat keeps them there.
      await p.heartbeat("c-cal-2", { userId: "u-cal", ...room, runId: "r-1" });
      await p.heartbeat("c-cal-1", { userId: "u-cal", ...room, runId: null });
      assert.deepEqual(await p.onlineInRun("r-1"), ["u-cal"], "the second tab is still on it");
      const bye = await p.disconnect("c-cal-2");
      assert.deepEqual([bye.changed, bye.sessionIds], [true, ["s-run"]]);
      assert.deepEqual(await p.onlineInRun("r-1"), [], "closing the last tab on it leaves");
      t += TTL_MS + 1;
      assert.deepEqual(await p.onlineInRun("r-2"), [], "a silent tab drops out with the TTL");
    });

    await test(label, "an unknown user is offline, not an error", async () => {
      assert.equal(await p.isOnline("u-nobody"), false);
      assert.deepEqual(await p.onlineInSession("s-nope"), []);
    });

    await p.close();
  }

  console.log(`\n${passed} passed, ${failed} failed\n`);
  process.exit(failed > 0 ? 1 : 0);
}

void main();
