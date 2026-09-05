/**
 * The repo lock, exercised on both drivers.
 *
 * The in-process driver serialises development; the Redis driver is what makes
 * a web-process save and a worker-process commit safe once they are separate
 * processes. The risk worth testing is the two disagreeing, so both run the
 * same mutual-exclusion checks. The Redis driver runs against a fake with real
 * `SET NX PX` / `EVAL` semantics on a fake clock, so the TTL safety valve can
 * be crossed without waiting — the same approach as the presence suite.
 *
 * Run with `npm run test:lock` — it compiles the TypeScript first.
 */
const assert = require("node:assert/strict");
const { createMemoryLock, createRedisLock } = require("../.test-build/lock.js");

let passed = 0;
let failed = 0;

async function test(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`  ok  ${name}`);
  } catch (cause) {
    failed++;
    console.error(`FAIL  ${name}`);
    console.error(cause);
  }
}

/** Lets other already-scheduled microtasks and timers run before continuing. */
const yieldEventLoop = () => new Promise((r) => setImmediate(r));

/**
 * Redis with real key/expiry semantics for exactly the commands the lock uses:
 * `SET … NX PX`, and the two compare-and-act Lua scripts (release, renew).
 * Time is a counter the test advances, so a TTL lapse is instant.
 */
function fakeRedis() {
  const store = new Map(); // key -> { value, expireAt }
  let now = 0;

  const live = (key) => {
    const entry = store.get(key);
    if (!entry) return null;
    if (entry.expireAt <= now) {
      store.delete(key);
      return null;
    }
    return entry;
  };

  return {
    tick: (ms) => {
      now += ms;
    },
    async set(key, value, options) {
      if (options && options.NX && live(key)) return null;
      store.set(key, { value, expireAt: now + options.PX });
      return "OK";
    },
    async eval(script, { keys, arguments: args }) {
      const entry = live(keys[0]);
      const ownsIt = entry && entry.value === args[0];
      if (script.includes("del")) {
        if (!ownsIt) return 0;
        store.delete(keys[0]);
        return 1;
      }
      // renew
      if (!ownsIt) return 0;
      entry.expireAt = now + Number(args[1]);
      return 1;
    },
  };
}

/** A delay bound to the fake clock: every backoff also advances time. */
const clockDelay = (redis) => async (ms) => {
  redis.tick(ms);
  await yieldEventLoop();
};

async function main() {
  // --- in-process driver -------------------------------------------------
  await test("memory: same id serialises, never interleaves", async () => {
    const lock = createMemoryLock();
    const log = [];
    const one = lock.withLock("x", async () => {
      log.push("a:enter");
      await yieldEventLoop();
      log.push("a:exit");
    });
    const two = lock.withLock("x", async () => {
      log.push("b:enter");
      log.push("b:exit");
    });
    await Promise.all([one, two]);
    assert.deepEqual(log, ["a:enter", "a:exit", "b:enter", "b:exit"]);
  });

  await test("memory: different ids run concurrently", async () => {
    const lock = createMemoryLock();
    const log = [];
    const x = lock.withLock("x", async () => {
      log.push("x:enter");
      await yieldEventLoop();
      log.push("x:exit");
    });
    const y = lock.withLock("y", async () => {
      log.push("y:enter");
      await yieldEventLoop();
      log.push("y:exit");
    });
    await Promise.all([x, y]);
    // Interleaved: both entered before either exited.
    assert.deepEqual(log.slice(0, 2).sort(), ["x:enter", "y:enter"]);
  });

  await test("memory: a rejection does not poison the queue", async () => {
    const lock = createMemoryLock();
    await assert.rejects(lock.withLock("x", async () => {
      throw new Error("boom");
    }));
    const value = await lock.withLock("x", async () => 42);
    assert.equal(value, 42);
  });

  // --- Redis driver ------------------------------------------------------
  await test("redis: same id serialises across withLock calls", async () => {
    const redis = fakeRedis();
    const lock = createRedisLock(redis, { delay: clockDelay(redis), ttlMs: 30_000, retryDelayMs: 100 });
    const log = [];
    const one = lock.withLock("x", async () => {
      log.push("a:enter");
      await yieldEventLoop();
      await yieldEventLoop();
      log.push("a:exit");
    });
    const two = lock.withLock("x", async () => {
      log.push("b:enter");
      log.push("b:exit");
    });
    await Promise.all([one, two]);
    assert.deepEqual(log, ["a:enter", "a:exit", "b:enter", "b:exit"]);
  });

  await test("redis: different ids acquire independently", async () => {
    const redis = fakeRedis();
    const lock = createRedisLock(redis, { delay: clockDelay(redis) });
    let both = false;
    await lock.withLock("x", async () => {
      // Held on x; y must still be acquirable since it is a different key.
      await lock.withLock("y", async () => {
        both = true;
      });
    });
    assert.equal(both, true);
  });

  await test("redis: a crashed holder's lock frees on TTL, then is reacquired", async () => {
    const redis = fakeRedis();
    const lock = createRedisLock(redis, { delay: clockDelay(redis), ttlMs: 5_000, retryDelayMs: 1_000 });
    // A holder that died without releasing: the key exists with someone else's
    // token and no one will ever delete it.
    await redis.set("repo-lock:x", "ghost", { NX: true, PX: 5_000 });
    let entered = false;
    // Spins on the ghost; each backoff advances the clock, so once the ghost's
    // 5s TTL lapses the NX set finally wins. Without the TTL this would hang.
    await lock.withLock("x", async () => {
      entered = true;
    });
    assert.equal(entered, true);
  });

  await test("redis: release only clears our own token", async () => {
    const redis = fakeRedis();
    const lock = createRedisLock(redis, { delay: clockDelay(redis), ttlMs: 30_000 });
    await lock.withLock("x", async () => {
      // Simulate the lock having expired and been retaken by someone else
      // mid-task: overwrite the key with a foreign token.
      redis.tick(30_001);
      await redis.set("repo-lock:x", "someone-else", { NX: true, PX: 30_000 });
    });
    // Our release must NOT have deleted the foreign holder's key.
    const survivor = await redis.eval("get-check del", {
      keys: ["repo-lock:x"],
      arguments: ["someone-else"],
    });
    assert.equal(survivor, 1, "foreign token should still own the key after our release");
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

main();
