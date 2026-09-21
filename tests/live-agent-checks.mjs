import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

/** Opt-in only: uses the operator's connected provider and can consume credits.
 * Called inside the browser harness's temporary SQL schema/repository. */
export async function liveAgentChecks({ server, token, roomId, sql, view, agentId }) {
  const request = (path, method = "GET", body) => fetch(`${server}${path}`, {
    method, headers: { cookie: `ma_auth=${token}`, "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(180_000),
  });
  const projectCode = randomUUID(), reviewLabel = `cedar-${randomUUID()}`;
  const source = await request(`/api/sessions/${roomId}/file`, "PUT", {
    path: "demo-context.json", baseText: "", text: JSON.stringify({ projectCode, counts: [17, 25] }),
  });
  assert.equal(source.status, 200, await source.text());
  let runId;
  async function turn(prompt) {
    const turnId = randomUUID(), began = performance.now();
    const response = await request("/api/ai/run", "POST", {
      sessionId: roomId, agentId, turnId, prompt,
      ...(runId ? { runId, controlVersion: 0 } : { title: "Live AI readiness check" }),
    });
    assert.equal(response.status, 200, response.status === 200 ? undefined : await response.text());
    const events = (await response.text()).trim().split("\n").filter(Boolean).map(line => JSON.parse(line));
    const exit = events.findLast(event => event.t === "exit");
    assert.ok(exit, "Live stream must terminate with an exit event");
    assert.equal(exit.code, 0, `Provider failed: ${events.filter(event => event.t === "err").map(event => event.d).join("").slice(-2000)}`);
    const saved = (await sql(`SELECT t.status,t.run_id,r.status AS run_status FROM agent_turns t
      JOIN agent_runs r ON r.id=t.run_id WHERE t.id=$1`, [turnId])).rows[0];
    assert.equal(saved?.status, "completed");assert.equal(saved.run_status, "completed");
    runId = saved.run_id;
    const text = events.filter(event => event.t === "out").map(event => event.d).join("").trim();
    const messages = (await sql(`SELECT body FROM agent_run_messages WHERE run_id=$1 AND role='agent' ORDER BY seq DESC LIMIT 1`, [runId])).rows;
    assert.equal(messages[0]?.body, text, "Streamed answer must match durable transcript");
    console.log(`  ok live ${agentId}: completed and persisted turn (${Math.round(performance.now() - began)} ms)`);
    return { text, exit };
  }
  const answer = await turn(`Our review label is ${reviewLabel}. Remember it for this conversation. Read demo-context.json from this repository. Reply only with JSON containing projectCode and the sum of counts as sum. Do not modify files.`);
  const json = answer.text.match(/\{[^{}]*\}/)?.[0];
  assert.ok(json, `Expected a JSON answer, got: ${answer.text.slice(0,500)}`);
  assert.deepEqual(JSON.parse(json), { projectCode, sum: 42 });
  assert.equal(answer.exit.committed, false);
  const followup = await turn("What exact review label did I give you in my previous message? Reply with that label only. Do not modify files.");
  assert.equal(followup.text.replace(/^`|`$/g, ""), reviewLabel);
  assert.equal(followup.exit.committed, false);
  const edited = await turn("Create demo-result.txt containing our exact review label, then a space, then sum=42, then a newline. Use the review label from this conversation. Leave all other files unchanged. Do not make a git commit yourself; the app commits your edit.");
  assert.equal(edited.exit.committed, true);
  assert.match(edited.exit.headSha, /^[0-9a-f]{40,64}$/);
  const file = await request(`/api/sessions/${roomId}/file?path=demo-result.txt`);
  assert.equal(file.status, 200);
  assert.equal((await file.json()).text, `${reviewLabel} sum=42\n`);
  assert.deepEqual(edited.exit.changes.map(change => change.path), ["demo-result.txt"]);
  await view.command("Page.navigate", { url: `${server}/s/${roomId}` });
  let visible = false;
  for(let attempt=0;attempt<60;attempt++) {
    visible=await view.evaluate(`Array.from(document.querySelectorAll('button')).some(button => button.getAttribute('aria-label') === 'File: demo-result.txt')`);
    if(visible) break;
    await new Promise(resolve=>setTimeout(resolve,500));
  }
  assert.ok(visible,"Confirmed AI edit must appear after browser reload");
  console.log(`  ok live ${agentId}: exact repository answer, follow-up memory, committed edit, and browser reload`);
}
