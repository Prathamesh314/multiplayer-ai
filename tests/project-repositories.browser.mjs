/** Browser checks of repository selection in the real workspace UI with isolated, in-browser API fixtures.
 * npm run test:workspace-ui starts an isolated development server so React
 * reconciliation warnings are checked. No fixture request reaches the database.
 * PROJECT_UI_BASE_URL=http://127.0.0.1:3105 node tests/project-repositories.browser.mjs
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";

const base = process.env.PROJECT_UI_BASE_URL ?? "http://127.0.0.1:3105";
let serverOutput = "";
const server = process.argv.includes("--start-server") ? spawn(process.execPath, ["node_modules/next/dist/bin/next", "dev", "--webpack", "--hostname", "127.0.0.1", "--port", new URL(base).port], {
  env:{...process.env, NEXT_TEST_DIST_DIR:".next-handoff-test", NEXT_TELEMETRY_DISABLED:"1"}, stdio:["ignore","pipe","pipe"],
}) : null;
server?.stdout.on("data", data=>{serverOutput+=data;});
server?.stderr.on("data", data=>{serverOutput+=data;});
const directory = await mkdtemp(join(tmpdir(), "multiplayer-chat-ui-"));
const chrome = spawn(process.env.CHROME_BIN ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", [
  "--headless=new", "--disable-gpu", "--no-first-run", "--no-default-browser-check",
  "--remote-debugging-port=9337", `--user-data-dir=${directory}`, "about:blank",
], { stdio: "ignore" });
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function eventually(task, label) {
  for (let i = 0; i < 300; i++) { if (await task()) return; await delay(100); }
  throw new Error(`Timed out: ${label}`);
}

function installFixtures() {
  const room = { id: "modelroomabc", name: "Alice", joinCode: "ABCD-EFGH", ownerId: "alice", orgId: "org", projectId: "project", visibility: "public", createdAt: 1, repo: null, lastActiveAt: 1, pinned: true, archivedAt: null, myRole: "owner" };
  const repositories = [{id:"11111111-1111-4111-8111-111111111111",name:"frontend"},{id:"22222222-2222-4222-8222-222222222222",name:"backend"}].map(r=>({...r,projectId:"project",defaultBranch:"main",ready:true}));
  const state = window.__model = { room, repos: [], runs: [], inputs: {}, sources: [], requests: [], unknown: [] };
  state.emit = (type, data={}) => state.sources.filter(source=>source.url.includes(`/sessions/${room.id}/events`)).forEach(source=>source.dispatchEvent(new MessageEvent(type,{data:JSON.stringify({type,...data})})));
  window.EventSource = class extends EventTarget {
    constructor(url) { super(); this.url=url;state.sources.push(this);setTimeout(()=>this.dispatchEvent(new MessageEvent("ready",{data:"{}"})),10); }
    close() { state.sources=state.sources.filter(source=>source!==this); }
  };
  const nativeFetch = window.fetch.bind(window);
  window.fetch = async (input, init={}) => {
    const u = new URL(typeof input === "string" ? input : input.url, location.origin), path=u.pathname;
    if (!path.startsWith("/api/")) return nativeFetch(input, init);
    state.requests.push({path,search:u.search,method:init.method ?? "GET",body:init.body});
    const json = body => new Response(JSON.stringify(body), {headers:{"content-type":"application/json"}});
    if (path === "/api/auth/me") return json({user:{id:"alice",handle:"alice",displayName:"Alice",email:"alice@example.test"}});
    if (path === "/api/sessions/modelroomabc") return json(room);
    if (path.endsWith("/project-repositories")) return json({repositories});
    if (path.endsWith("/repos")) {
      if (init.method === "POST") {
        const shared = repositories.find(r=>r.id===JSON.parse(init.body).projectRepositoryId);
        const repo = {id:shared.name==="frontend"?"frontendabcd":"backendabcde",sessionId:room.id,rootName:shared.name,projectRepositoryId:shared.id,headSha:"a".repeat(40),baseSha:"a".repeat(40),seededAt:1,createdAt:1,createdBy:"alice"};
        state.repos.push(repo);return json({repo});
      }
      return json({repos:state.repos});
    }
    if(path.endsWith("/tree")) {
      const repo=state.repos.find(r=>r.id===u.searchParams.get("repoId"));
      return json({rootName:repo.rootName,root:{name:repo.rootName,path:"",type:"directory",children:[{name:repo.rootName+".txt",path:repo.rootName+".txt",type:"file",size:10}]},headSha:repo.headSha,sessionBranch:"session/"+repo.id});
    }
    if(path.endsWith("/changes")) return json({changes:[]});
    if(path.endsWith("/publish") || path.endsWith("/sync")) return json({ok:true,sha:"b".repeat(40)});
    if(path.endsWith("/members"))return json({members:[{userId:"alice",handle:"alice",displayName:"Alice",role:"owner",online:true}]});
    if(path.endsWith("/runs"))return json({runs:state.runs});
    const runPath=path.match(/\/runs\/([^/]+)(?:\/(handoff|history|inputs|join))?$/);
    if(runPath) {
      const run=state.runs.find(item=>item.id===runPath[1]);
      if(runPath[2]==="handoff")return json({run,offers:[],recipients:[]});
      if(runPath[2]==="history")return json({turns:[],snapshots:[],selectedSnapshotId:null});
      if(runPath[2]==="join")return json({ok:true});
      if(runPath[2]==="inputs") {
        const inputs=state.inputs[run.id]??=[];
        if(init.method==="POST") {const input={...JSON.parse(init.body),runId:run.id,status:"queued",createdAt:new Date().toISOString()};inputs.push(input);return json({input});}
        return json({inputs});
      }
      return json({run,messages:[]});
    }
    if(path==="/api/tasks")return json({tasks:[],members:[],hasMore:false});
    if(path.endsWith("/handoffs"))return json({offers:[]});
    if(path.endsWith("/messages"))return json({messages:[]});
    if(path.endsWith("/forkable-runs"))return json({runs:[]});
    if(path.endsWith("/mention-targets"))return json({rooms:[{sessionId:room.id,name:room.name,chats:state.runs.map(run=>({runId:run.id,title:run.title}))}]});
    if(path === "/api/ai/agents")return json({agents:[],canRun:false,reason:"Connect a runner"});
    if(path === "/api/presence")return json({intervalMs:20000,online:["alice"]});
    if(path === "/api/runner/devices")return json({devices:[]});
    state.unknown.push(path);return json({});
  };
}

let socket; let debugEvaluate;
try {
  if(server)await eventually(async()=>{if(server.exitCode!==null)throw Error(serverOutput);try{return(await fetch(base+"/s/modelroomabc")).ok;}catch{return false;}},"development server");
  let targets;
  await eventually(async()=>{try {targets=await (await fetch("http://127.0.0.1:9337/json")).json();return targets.length;}catch{return false;}},"browser");
  socket = new WebSocket(targets.find(target=>target.type==="page").webSocketDebuggerUrl);
  await once(socket,"open");
  let sequence=0; const pending=new Map();const errors=[];const keyWarnings=[];
  socket.onmessage=event=>{
    const message=JSON.parse(event.data);
    if(message.method==="Runtime.exceptionThrown")errors.push(message.params.exceptionDetails.text);
    if(message.method==="Runtime.consoleAPICalled") {
      const text=message.params.args.map(arg=>arg.value??arg.description??"").join(" ");
      if(/same key|unique ["']?key/i.test(text))keyWarnings.push(text);
    }
    const operation=pending.get(message.id);
    if(operation){pending.delete(message.id);clearTimeout(operation.timer);if(message.error)operation.reject(message.error);else operation.resolve(message.result);}
  };
  const send=(method,params={})=>new Promise((resolve,reject)=>{const id=++sequence;const timer=setTimeout(()=>{pending.delete(id);reject(Error(`CDP timeout: ${method}`));},15000);pending.set(id,{resolve,reject,timer});socket.send(JSON.stringify({id,method,params}));});
  const evaluate=async expression=>{const result=await send("Runtime.evaluate",{expression,returnByValue:true,awaitPromise:true});if(result.exceptionDetails)throw Error(JSON.stringify(result.exceptionDetails));return result.result.value;};
  debugEvaluate = evaluate;
  const click=async selector=>{assert.ok(await evaluate(`!!document.querySelector(${JSON.stringify(selector)})`),selector);await evaluate(`document.querySelector(${JSON.stringify(selector)}).click()`);await delay(80);};
  const type=async(selector,value)=>{await evaluate(`(()=>{const el=document.querySelector(${JSON.stringify(selector)});Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el),'value').set.call(el,${JSON.stringify(value)});el.dispatchEvent(new Event('input',{bubbles:true}));})()`);await delay(80);};
  await send("Page.enable");await send("Runtime.enable");
  await send("Page.addScriptToEvaluateOnNewDocument",{source:`(${installFixtures.toString()})()`});
  await send("Emulation.setDeviceMetricsOverride",{width:1440,height:900,deviceScaleFactor:1,mobile:false});
  await send("Page.navigate",{url:base+"/s/modelroomabc"});
  const button = text => evaluate(`Array.from(document.querySelectorAll('button')).find(b=>b.textContent.trim()===${JSON.stringify(text)})?.click()`);
  await eventually(()=>evaluate('document.body.innerText.includes("Project repositories")'),"empty room");
  assert.equal(await evaluate(`document.querySelector('select[aria-label="Active repository"]').options.length`),1);
  await button("Project repositories");
  await eventually(()=>evaluate('document.querySelector("dialog")?.innerText.includes("frontend")'),"repository catalog");
  await button("Add to room");
  await eventually(()=>evaluate('document.body.innerText.includes("frontend.txt")'),"first repository without primary");
  assert.equal(await evaluate(`document.querySelector('select[aria-label="Active repository"]').value`),"frontendabcd");
  await button("Project repositories");
  await eventually(()=>evaluate('document.querySelector("dialog")?.innerText.includes("Already in this room")'),"selected repository");
  await evaluate(`Array.from(document.querySelectorAll('dialog button')).find(b=>b.textContent.trim()==='Add to room' && !b.disabled).click()`);
  await eventually(()=>evaluate('document.body.innerText.includes("backend.txt")'),"second repository");
  assert.equal(await evaluate(`document.querySelector('select[aria-label="Active repository"]').options.length`),2);
  await button("Publish");
  await eventually(()=>evaluate('window.__model.requests.some(r=>r.path.endsWith("/publish"))'),"publish selected repository");
  assert.equal(await evaluate('window.__model.requests.find(r=>r.path.endsWith("/publish")).search'),"?repoId=backendabcde");
  await button("Get latest");
  await eventually(()=>evaluate('window.__model.requests.some(r=>r.path.endsWith("/sync"))'),"sync selected repository");
  assert.equal(await evaluate('window.__model.requests.find(r=>r.path.endsWith("/sync")).search'),"?repoId=backendabcde");
  await evaluate(`const picker=document.querySelector('select[aria-label="Active repository"]');picker.value='frontendabcd';picker.dispatchEvent(new Event('change',{bubbles:true}));`);
  await eventually(()=>evaluate('document.body.innerText.includes("frontend.txt")'),"switch repositories");
  // Two separate panels for one chat must not share a sibling key. Development
  // React reports this through console.error, not Runtime.exceptionThrown.
  await evaluate(`window.__model.runs=["aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa","bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"].map((id,index)=>({id,sessionId:"modelroomabc",repoId:"frontendabcd",startedBy:"alice",startedByName:"Alice",driverUserId:"alice",driverName:"Alice",controlVersion:0,agentId:"codex",title:"Queue context "+(index?"B":"A"),status:"running",baseSha:"a".repeat(40),createdAt:Date.now()+index,startedAt:Date.now(),endedAt:null,archivedAt:null}));window.__model.emit("run.started");`);
  await eventually(()=>evaluate(`!!document.querySelector('button[title^="Queue context A ·"]')`),"AI chats");
  await click('button[title^="Queue context A ·"]');
  await eventually(()=>evaluate(`!!document.querySelector('textarea[aria-label="Message working agent"]')`),"working chat queue");
  assert.deepEqual(keyWarnings,[],"opening a chat has no React key warnings");
  const queue='textarea[aria-label="Message working agent"]';
  await type(queue,"Keep this unsent instruction in chat A");
  await button("Hand off");
  await eventually(()=>evaluate('!!document.querySelector("dialog textarea")'),"handoff form");
  await type("dialog textarea","Finish the review before publishing");
  await evaluate('window.__model.runs[0].driverName="Alice refreshed";window.__model.emit("run.control")');
  await eventually(()=>evaluate(`!!document.querySelector('[aria-label="Chat control"] [title^="Alice refreshed is driving"]')`),"same-chat control refresh");
  assert.equal(await evaluate(`document.querySelector(${JSON.stringify(queue)}).value`),"Keep this unsent instruction in chat A","queue draft survives same-chat control refresh");
  assert.equal(await evaluate('document.querySelector("dialog textarea").value'),"Finish the review before publishing","handoff draft survives same-chat refresh");
  await click('button[aria-label="Close Hand off this chat"]');
  await click('button[title^="Queue context B ·"]');
  await eventually(()=>evaluate('document.querySelector(".ai-chat-header h2")?.textContent==="Queue context B"'),"second AI chat");
  assert.equal(await evaluate(`document.querySelector(${JSON.stringify(queue)}).value`),"","another chat does not inherit the queue draft");
  await button("Hand off");
  await eventually(()=>evaluate('!!document.querySelector("dialog textarea")'),"second handoff form");
  assert.equal(await evaluate('document.querySelector("dialog textarea").value'),"","another chat does not inherit the handoff draft");
  await click('button[aria-label="Close Hand off this chat"]');
  await type(queue,"Instruction for chat B only");await button("Queue message");
  await eventually(()=>evaluate(`document.querySelector('[aria-label="Chat message queue"]')?.textContent.includes("Instruction for chat B only")`),"queued instruction");
  assert.equal(await evaluate('window.__model.requests.filter(r=>r.method==="POST" && r.path.endsWith("/inputs")).at(-1).path'),"/api/sessions/modelroomabc/runs/bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb/inputs");
  assert.equal(await evaluate(`document.querySelectorAll('[aria-label="Chat control"]').length`),1);
  assert.equal(await evaluate(`document.querySelectorAll('[aria-label="Chat message queue"]').length`),1);
  assert.deepEqual(keyWarnings,[],"chat refresh and switching have no React key warnings");
  for (const width of [1440,390]) {
    await send("Emulation.setDeviceMetricsOverride",{width,height:900,deviceScaleFactor:1,mobile:width===390});await delay(200);
    assert.ok(await evaluate('document.documentElement.scrollWidth <= window.innerWidth'),`no page overflow at ${width}`);
    await writeFile(join(tmpdir(),`multiplayer-project-model-${width}.png`),Buffer.from((await send("Page.captureScreenshot")).data,"base64"));
  }
  assert.deepEqual(errors,[]);
  assert.deepEqual(await evaluate("window.__model.unknown"),[]);
  console.log("PASS: unique React panel identities, same-chat draft preservation, cross-chat state isolation, queue routing, empty room, select two repositories, file browsing, switch, repository-scoped publish/sync, desktop/mobile layouts.");
  console.log("Unmocked requests:",await evaluate("window.__model.unknown"));
} catch (error) { console.log(await debugEvaluate?.(`JSON.stringify({body:document.body.innerText,state:{unknown:window.__model.unknown,requests:window.__model.requests.filter(r=>r.path!=="/api/presence")}})`)); throw error; } finally {socket?.close();chrome.kill();if(server && server.exitCode===null){server.kill();await once(server,"exit").catch(()=>{});}}
