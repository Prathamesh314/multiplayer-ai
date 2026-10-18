// Members choose their own @username; it stays unique, readable and theirs.
import assert from "node:assert/strict";
import { test } from "node:test";
import { memoryFixture } from "./helpers/memory-fixture.mjs";
import { changeHandle } from "../app/lib/repo/users.ts";

test("a member changes their @username, within the rules", async () => {
  const f = await memoryFixture();
  try {
    const changed = await changeHandle(f.alice, " @Alex_Chen ");
    assert.equal(changed.handle, "alex_chen", "a leading @ and capitals are tidied");
    assert.equal((await f.first("SELECT handle FROM users WHERE id=$1", [f.alice])).handle, "alex_chen");
    for (const bad of ["a", "-alex", "alex chen", "álex", "x".repeat(40), "", null]) {
      await assert.rejects(changeHandle(f.alice, bad), (e) => e.status === 400, String(bad));
    }
    await assert.rejects(changeHandle(f.alice, "admin"), /reserved/);
    await assert.rejects(changeHandle(f.alice, "BOB"), (e) => e.status === 409 && /taken/.test(e.message), "unique ignoring case");
    assert.equal((await changeHandle(f.alice, "alex_chen")).handle, "alex_chen", "keeping it is fine");
  } finally {
    await f.close();
  }
});
