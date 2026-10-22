// Older chats stored a changed-files list after each run; it is skipped when they load.
import assert from "node:assert/strict";
import { test } from "node:test";
import { isChangeSummary } from "../app/lib/ai/change-summary.ts";

test("stored changed-files lists are recognised, nothing else is", () => {
  assert.equal(isChangeSummary("Changed 8 files (+126 −126)\n· a.csv  +31 −0"), true);
  assert.equal(isChangeSummary("Changed 1 file (+2 −0)"), true);
  assert.equal(isChangeSummary("Finished in 38.5s · committed 9c9a828e"), false);
  assert.equal(isChangeSummary("Changed the plan: I'll start with tests."), false);
  assert.equal(isChangeSummary("Execution failed before producing a confirmed result."), false);
});
