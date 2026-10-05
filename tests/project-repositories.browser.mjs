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
  const computer={id:"computer-1",userId:"alice",name:"Alice’s Mac",platform:"darwin",version:"2",lastSeenAt:Date.now(),createdAt:1,revokedAt:null,online:true};
  const state = window.__model = { room, repos: [], runs: [], inputs: {}, files: {}, failSave: false, devices:[computer], deviceFailure:false, agentsFailure:false, aiReady:true, sources: [], requests: [], unknown: [] };
  state.emit = (type, data={}) => state.sources.filter(source=>source.url.includes(`/sessions/${room.id}/events`)).forEach(source=>source.dispatchEvent(new MessageEvent(type,{data:JSON.stringify({type,...data})})));
  state.emitDevices = () => state.sources.filter(source=>source.url==="/api/events").forEach(source=>source.dispatchEvent(new MessageEvent("devices.changed",{data:"{}"})));
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
    if (path === "/api/orgs") return json({orgs:[{id:"org",slug:"team",name:"Alice’s workspace",myRole:"owner",createdAt:1}]});
    if (path === "/api/invitations") return json({invitations:[]});
    if (path.endsWith("/projects")) return json({projects:[{id:"project",slug:"project",name:"My project",orgId:"org",myRole:"manager",createdAt:1,archivedAt:null}]});
    if (path.endsWith("/rooms")) return json({sessions:[room]});
    if (path.endsWith("/usage")) return json({concurrency:{used:0,limit:3},monthly:{used:0,limit:null}});
    if (path === "/api/sessions/modelroomabc") return json(room);
    if (path.endsWith("/project-repositories")) return json({repositories});
    if (path.endsWith("/repos")) {
      if (init.method === "POST") {
        const body=JSON.parse(init.body);
        if(body.empty) {
          if(state.failCreate)return new Response(JSON.stringify({error:"Could not create the project. Please try again."}),{status:503,headers:{"content-type":"application/json"}});
          if(state.repos.some(repo=>repo.rootName===body.name))return new Response(JSON.stringify({error:"A project with that name is already in this room. Choose another name."}),{status:409,headers:{"content-type":"application/json"}});
          const repo={id:"emptyproject",sessionId:room.id,rootName:body.name,projectRepositoryId:null,headSha:"e".repeat(40),baseSha:"e".repeat(40),seededAt:1,createdAt:1,createdBy:"alice",empty:true};
          state.repos.push(repo);return json({repo});
        }
        const shared = repositories.find(r=>r.id===body.projectRepositoryId);
        const repo = {id:shared.name==="frontend"?"frontendabcd":"backendabcde",sessionId:room.id,rootName:shared.name,projectRepositoryId:shared.id,headSha:"a".repeat(40),baseSha:"a".repeat(40),seededAt:1,createdAt:1,createdBy:"alice"};
        state.repos.push(repo);return json({repo});
      }
      return json({repos:state.repos});
    }
    if(path.endsWith("/tree")) {
      const repo=state.repos.find(r=>r.id===u.searchParams.get("repoId"));
      return json({rootName:repo.rootName,root:{name:repo.rootName,path:"",type:"directory",children:repo.empty?[]:[{name:repo.rootName+".txt",path:repo.rootName+".txt",type:"file",size:10}]},headSha:repo.headSha,sessionBranch:"session/"+repo.id});
    }
    if(path.endsWith("/changes")) return json({changes:[]});
    if(path.endsWith("/file")) {
      if(init.method === "PUT") {
        if(state.failSave) return new Response(JSON.stringify({error:"Save unavailable"}),{status:503,headers:{"content-type":"application/json"}});
        const file=JSON.parse(init.body);state.files[file.path]=file.text;
        return json({headSha:"c".repeat(40),conflict:false});
      }
      const text=state.files[u.searchParams.get("path")] ?? "Original file contents";
      return json({text,size:text.length,truncated:false,binary:false});
    }
    if(path.endsWith("/activity")) return json({ok:true});
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
      return json({run,messages:[{role:"user",body:"Review the repository and explain how the session works."},{role:"assistant",body:"## Session workspace\n\nThe repository is ready. Use `executeAgentRun` to start an agent turn.\n\n### Next steps\n\nSelect a file to inspect its contents, or continue the conversation."}]});
    }
    if(path==="/api/tasks")return json({tasks:[],members:[],hasMore:false});
    if(path.endsWith("/handoffs"))return json({offers:[]});
    if(path.endsWith("/messages"))return json({messages:[]});
    if(path.endsWith("/forkable-runs"))return json({runs:[]});
    if(path.endsWith("/mention-targets"))return json({rooms:[{sessionId:room.id,name:room.name,chats:state.runs.map(run=>({runId:run.id,title:run.title}))}]});
    if(path === "/api/terminal")return json({enabled:false,reason:"Terminal disabled in browser fixture"});
    if(path === "/api/ai/agents") {
      if(state.agentsFailure)return new Response("Temporarily unavailable",{status:503});
      const ready=state.devices.some(device=>device.online&&device.version==="2")&&state.aiReady;
      return json({agents:[{id:"codex",name:"Codex",vendor:"OpenAI",installed:ready,execution:"runner",install:{command:"npm install -g @openai/codex"},models:{choices:[{id:"",label:"Automatic"},{id:"fixture/model-a",label:"Model Alpha"},{id:"fixture/model-b",label:"Model Beta"}],source:"Browser fixture",checkedAt:1,refreshedAt:1,stale:false}}],canRun:ready,reason:ready?null:"Connect your computer, then install and sign in to an AI tool on it."});
    }
    if(path === "/api/presence")return json({intervalMs:20000,online:["alice"]});
    if(path === "/api/runner/devices") {
      if(state.deviceFailure)return new Response("Temporary upstream error",{status:502});
      return json({devices:state.devices,requiresComputer:true});
    }
    if(path === "/api/runner/pairing")return json({code:"RN-ABCD-EFGH",expiresAt:Date.now()+600000});
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
  // CDP navigation returns before a cold CI browser has created the new body.
  // Wait for this document and its fixtures before reading page content.
  await eventually(()=>evaluate('!!document.body && !!window.__model'),"workspace document");
  const button = text => evaluate(`Array.from(document.querySelectorAll('button')).find(b=>b.textContent.trim()===${JSON.stringify(text)})?.click()`);
  await eventually(()=>evaluate('!!document.querySelector(\'button[aria-label="Add project"]\')'),"empty room");
  await button("Start empty project");
  await eventually(()=>evaluate('!!document.querySelector(\'dialog[aria-label="Start empty project"] input\')'),"empty project available without any repository");
  assert.equal(await evaluate('Array.from(document.querySelectorAll("dialog button")).find(button=>button.textContent==="Create project").disabled'),true,"empty project needs a name");
  await button("Cancel");
  await click('button[aria-label="Add project"]');
  await button("Project repositories");
  await eventually(()=>evaluate('Array.from(document.querySelectorAll("dialog")).some(dialog=>dialog.innerText.includes("frontend"))'),"repository catalog");
  await button("Add to room");
  await eventually(()=>evaluate('document.body.innerText.includes("frontend.txt")'),"first repository without primary");
  assert.equal(await evaluate(`document.querySelectorAll('button[aria-label="New chat in frontend"]').length`),1);
  await click('button[aria-label="Add project"]');
  await button("Project repositories");
  await eventually(()=>evaluate('Array.from(document.querySelectorAll("dialog")).some(dialog=>dialog.innerText.includes("Already in this room"))'),"selected repository");
  await evaluate(`Array.from(document.querySelectorAll('dialog button')).find(b=>b.textContent.trim()==='Add to room' && !b.disabled).click()`);
  await eventually(()=>evaluate('document.body.innerText.includes("backend.txt")'),"second repository");
  assert.equal(await evaluate(`document.querySelectorAll('button[aria-label^="New chat in"]').length`),2);
  await button("Publish");
  await eventually(()=>evaluate('window.__model.requests.some(r=>r.path.endsWith("/publish"))'),"publish selected repository");
  assert.equal(await evaluate('window.__model.requests.find(r=>r.path.endsWith("/publish")).search'),"?repoId=backendabcde");
  await button("Get latest");
  await eventually(()=>evaluate('window.__model.requests.some(r=>r.path.endsWith("/sync"))'),"sync selected repository");
  assert.equal(await evaluate('window.__model.requests.find(r=>r.path.endsWith("/sync")).search'),"?repoId=backendabcde");
  await click('button[aria-label="New chat in frontend"]');
  await eventually(()=>evaluate('document.body.innerText.includes("frontend.txt")'),"switch repositories");
  // Native history entries exercise Next's back/forward traversal while keeping
  // this room mounted, including the guard against losing unsaved file edits.
  await evaluate('history.pushState(null,"","?navigation=previous");history.pushState(null,"","?navigation=current")');
  await click('button[aria-label="Go back"]');
  await eventually(()=>evaluate('location.search === "?navigation=previous"'),"back navigation");
  await click('button[aria-label="Go forward"]');
  await eventually(()=>evaluate('location.search === "?navigation=current"'),"forward navigation");
  await click('button[aria-label="File: frontend.txt"]');
  await eventually(()=>evaluate('!!document.querySelector(".room-file-document textarea")'),"editable file");
  await evaluate('window.__model.failSave=true');
  await type('.room-file-document textarea',"Keep my unsaved changes");
  await click('button[aria-label="Go back"]');
  await eventually(()=>evaluate('document.body.innerText.includes("Your edits are not saved yet")'),"navigation save failure");
  assert.equal(await evaluate('location.search'),"?navigation=current","failed save blocks navigation");
  assert.equal(await evaluate('document.querySelector(".room-file-document textarea").value'),"Keep my unsaved changes","blocked navigation preserves edits");
  await evaluate('window.__model.failSave=false');
  await click('button[aria-label="Go back"]');
  await eventually(()=>evaluate('location.search === "?navigation=previous"'),"retry navigation after save");
  assert.equal(await evaluate('window.__model.files["frontend.txt"]'),"Keep my unsaved changes","navigation flushes pending edits");
  await button("Dismiss");
  await click('button[aria-label="Go forward"]');
  await eventually(()=>evaluate('location.search === "?navigation=current"'),"forward after saving");
  await click('button[aria-label="Close frontend.txt"]');
  // Two separate panels for one chat must not share a sibling key. Development
  // React reports this through console.error, not Runtime.exceptionThrown.
  await evaluate(`window.__model.runs=["aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa","bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"].map((id,index)=>({id,sessionId:"modelroomabc",repoId:"frontendabcd",startedBy:"alice",startedByName:"Alice",driverUserId:"alice",driverName:"Alice",controlVersion:0,agentId:"codex",title:"Queue context "+(index?"B":"A"),status:"running",baseSha:"a".repeat(40),createdAt:Date.now()+index,startedAt:Date.now(),endedAt:null,archivedAt:null}));window.__model.emit("run.started");`);
  await eventually(()=>evaluate(`!!document.querySelector('button[title^="Queue context A ·"]')`),"AI chats");
  await click('button[title^="Queue context A ·"]');
  await eventually(()=>evaluate(`!!document.querySelector('textarea[aria-label="Message working agent"]')`),"working chat queue");
  assert.deepEqual(keyWarnings,[],"opening a chat has no React key warnings");
  const queue='textarea[aria-label="Message working agent"]';
  await type(queue,"Keep this unsent instruction in chat A");
  await button("Handoff");
  await eventually(()=>evaluate('!!document.querySelector("dialog textarea")'),"handoff form");
  await type("dialog textarea","Finish the review before publishing");
  await evaluate('window.__model.runs[0].driverName="Alice refreshed";window.__model.emit("run.control")');
  await eventually(()=>evaluate(`!!document.querySelector('[aria-label="Chat control"][title^="Alice refreshed is driving"]')`),"same-chat control refresh");
  assert.equal(await evaluate(`document.querySelector(${JSON.stringify(queue)}).value`),"Keep this unsent instruction in chat A","queue draft survives same-chat control refresh");
  assert.equal(await evaluate('document.querySelector("dialog textarea").value'),"Finish the review before publishing","handoff draft survives same-chat refresh");
  await click('button[aria-label="Close Hand off this chat"]');
  await click('button[title^="Queue context B ·"]');
  await eventually(()=>evaluate('document.querySelector(".ai-chat-header h2")?.textContent==="Queue context B"'),"second AI chat");
  assert.equal(await evaluate(`document.querySelector(${JSON.stringify(queue)}).value`),"","another chat does not inherit the queue draft");
  await button("Handoff");
  await eventually(()=>evaluate('!!document.querySelector("dialog textarea")'),"second handoff form");
  assert.equal(await evaluate('document.querySelector("dialog textarea").value'),"","another chat does not inherit the handoff draft");
  await click('button[aria-label="Close Hand off this chat"]');
  await type(queue,"Instruction for chat B only");await button("Queue message");
  await eventually(()=>evaluate(`document.querySelector('[aria-label="Chat message queue"]')?.textContent.includes("Instruction for chat B only")`),"queued instruction");
  assert.equal(await evaluate('window.__model.requests.filter(r=>r.method==="POST" && r.path.endsWith("/inputs")).at(-1).path'),"/api/sessions/modelroomabc/runs/bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb/inputs");
  assert.equal(await evaluate(`document.querySelectorAll('[aria-label="Chat control"]').length`),1);
  assert.equal(await evaluate(`document.querySelectorAll('[aria-label="Chat message queue"]').length`),1);
  assert.deepEqual(keyWarnings,[],"chat refresh and switching have no React key warnings");
  assert.deepEqual(await evaluate(`Array.from(document.querySelector('.file-actions').querySelectorAll('button')).map(button=>button.textContent.trim())`), ["Assign Tasks", "Handoff", "Review"]);
  await button("Assign Tasks");
  await eventually(()=>evaluate(`!!document.querySelector('dialog[aria-label="Assign Tasks"]')`),"task assignment dialog");
  await click('button[aria-label="Close Assign Tasks"]');
  assert.equal(await evaluate(`document.querySelector('.human-message')?.textContent`),"Review the repository and explain how the session works.");
  assert.ok(await evaluate(`document.querySelector('.conversation-markdown code')?.textContent.includes('executeAgentRun')`));
  const widthBefore = await evaluate(`document.querySelector('.room-sidebar').getBoundingClientRect().width`);
  await evaluate(`document.querySelector('[aria-label="Resize workspace panel"]').dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowRight',bubbles:true}))`);
  await delay(100);
  assert.equal(await evaluate(`document.querySelector('.room-sidebar').getBoundingClientRect().width`),widthBefore+24);
  assert.equal(await evaluate(`Array.from(document.querySelector('.room-main').querySelectorAll('button')).some(button=>/assign task/i.test(button.textContent))`),false,"no duplicate assignment action in conversation");
  assert.equal(await evaluate(`getComputedStyle(document.documentElement).getPropertyValue('--vs-editor').trim()`),"#141210","shared warm workspace palette");
  await click('button[aria-label="New chat in frontend"]');
  await eventually(()=>evaluate(`!!document.querySelector('button[aria-label="Choose model"]')`),"ready composer");
  assert.equal(await evaluate(`document.querySelectorAll('.ai-composer select').length`),0,"composer uses arrow-free custom controls");
  await click('button[aria-label="Choose model"]');
  await eventually(()=>evaluate(`!!document.querySelector('.composer-picker [role="option"]')`),"model popover");
  assert.ok(await evaluate(`(()=>{const trigger=document.querySelector('button[aria-label="Choose model"]').getBoundingClientRect();const popup=document.querySelector('.composer-picker').getBoundingClientRect();return popup.bottom < trigger.top && popup.top >= 0 && popup.right <= innerWidth;})()`),"model menu opens above composer within viewport");
  assert.equal(await evaluate(`getComputedStyle(document.querySelector('.composer-picker-option')).fontSize`),"16px");
  await type('input[aria-label="Search models"]',"Beta");
  assert.equal(await evaluate(`document.querySelectorAll('.composer-picker [role="option"]').length`),1,"model search filters live inventory");
  await click('.composer-picker [role="option"]');
  assert.equal(await evaluate(`document.querySelector('button[aria-label="Choose model"]').textContent`),"Model Beta");
  assert.equal(await evaluate(`document.activeElement.getAttribute('aria-label')`),"Choose model","selection restores focus");
  await click('button[aria-label="Reasoning effort"]');
  await evaluate(`Array.from(document.querySelectorAll('.composer-picker [role="option"]')).find(button=>button.textContent==='High').click()`);
  await delay(80);
  assert.equal(await evaluate(`document.querySelector('button[aria-label="Reasoning effort"]').textContent`),"High");
  await click('button[aria-label="Reasoning effort"]');
  await send("Input.dispatchKeyEvent",{type:"keyDown",key:"ArrowUp",code:"ArrowUp",windowsVirtualKeyCode:38});
  assert.equal(await evaluate(`document.activeElement.textContent`),"Medium","arrow keys navigate choices");
  await send("Input.dispatchKeyEvent",{type:"keyDown",key:"Escape",code:"Escape",windowsVirtualKeyCode:27});
  assert.equal(await evaluate(`!!document.querySelector('.composer-picker')`),false,"Escape closes popover");
  assert.equal(await evaluate(`document.activeElement.getAttribute('aria-label')`),"Reasoning effort");
  await click('button[aria-label="Choose model"]');
  await writeFile(join(tmpdir(),'multiplayer-composer-picker.png'),Buffer.from((await send("Page.captureScreenshot")).data,"base64"));
  await send("Input.dispatchMouseEvent",{type:"mousePressed",x:500,y:140,button:"left",clickCount:1});
  await send("Input.dispatchMouseEvent",{type:"mouseReleased",x:500,y:140,button:"left",clickCount:1});
  await eventually(()=>evaluate(`!document.querySelector('.composer-picker')`),"outside click closes picker");
  for (const width of [1440,390]) {
    await send("Emulation.setDeviceMetricsOverride",{width,height:900,deviceScaleFactor:1,mobile:width===390});await delay(200);
    assert.ok(await evaluate('document.documentElement.scrollWidth <= window.innerWidth'),`no page overflow at ${width}`);
    await writeFile(join(tmpdir(),`multiplayer-project-model-${width}.png`),Buffer.from((await send("Page.captureScreenshot")).data,"base64"));
  }
  await send("Emulation.setDeviceMetricsOverride",{width:1440,height:900,deviceScaleFactor:1,mobile:false});
  await evaluate('window.__model.devices=[];window.__model.runs.forEach(run=>run.status="completed");window.__model.emit("run.finished",{runId:window.__model.runs[0].id,status:"completed"});window.__model.emitDevices()');
  await eventually(()=>evaluate('document.querySelector(\'[aria-label="Computer connection"]\')?.dataset.status==="not-connected"'),"no computer explanation");
  await click('button[title^="Queue context A ·"]');
  await eventually(()=>evaluate('document.querySelector(".human-message")?.textContent.includes("Review the repository")'),"saved chat opens without a computer");
  assert.ok(await evaluate('document.querySelector(".conversation-transcript").getBoundingClientRect().height > 100'),"offline setup does not hide the conversation");
  assert.ok(await evaluate('document.querySelector(\'button[aria-label="Send message"]\').disabled'),"AI execution needs a computer");
  await click('button[title="Back to projects"]');
  await eventually(()=>evaluate('location.pathname==="/workspace" && !!document.querySelector("main h1")'),"workspace overview");
  await eventually(()=>evaluate('document.querySelector(\'[aria-label="Computer connection"]\')?.dataset.status==="not-connected"'),"workspace connection prompt");
  assert.ok(await evaluate('document.querySelector(\'[aria-label="Computer connection"]\').getBoundingClientRect().top < document.querySelector("#projects-heading").getBoundingClientRect().top'),"connection prompt appears before projects");
  await button("Connect computer");
  await eventually(()=>evaluate('!!document.querySelector(\'dialog a[href="/#download"]\')'),"desktop setup instructions");
  assert.equal(await evaluate('document.querySelector("dialog details").open'),false,"terminal setup is optional and collapsed");
  await click('button[aria-label="Close Your computers"]');
  await evaluate('window.__model.deviceFailure=true;window.__model.emitDevices()');
  await eventually(()=>evaluate('document.querySelector(\'[aria-label="Computer connection"]\')?.dataset.status==="error"'),"network failure is not reported as no computer");
  await evaluate('window.__model.deviceFailure=false');
  await click('[aria-label="Computer connection"] button');
  await eventually(()=>evaluate('document.querySelector(\'[aria-label="Computer connection"]\')?.dataset.status==="not-connected"'),"connection retry recovers");
  for (const width of [1440,390]) {
    await send("Emulation.setDeviceMetricsOverride",{width,height:900,deviceScaleFactor:1,mobile:width===390});await delay(200);
    assert.ok(await evaluate('document.documentElement.scrollWidth <= innerWidth'),`connection onboarding fits ${width}`);
    assert.ok(await evaluate('document.querySelector(\'[aria-label="Computer connection"]\').getBoundingClientRect().height < 300'),`connection text remains readable at ${width}`);
    await writeFile(join(tmpdir(),`multiplayer-computer-setup-${width}.png`),Buffer.from((await send("Page.captureScreenshot")).data,"base64"));
  }
  await send("Emulation.setDeviceMetricsOverride",{width:1440,height:900,deviceScaleFactor:1,mobile:false});
  await button("Open my room");
  await eventually(()=>evaluate('location.pathname==="/s/modelroomabc" && !!document.querySelector(\'button[title^="Queue context A ·"]\')'),"room opens without a computer");
  await click('button[title^="Queue context A ·"]');
  await eventually(()=>evaluate('!!document.querySelector(".human-message")'),"history remains readable");
  await evaluate('window.__model.devices=[{id:"computer-1",userId:"alice",name:"Alice’s Mac",version:"2",online:false,lastSeenAt:Date.now()-60000}];window.__model.emitDevices()');
  await eventually(()=>evaluate('document.querySelector(\'[aria-label="Computer connection"]\')?.dataset.status==="offline"'),"previously connected computer is offline");
  await button("Reconnect computer");
  await eventually(()=>evaluate('document.querySelector("dialog")?.innerText.includes("Bring your computer back online")'),"reconnection help");
  await click('button[aria-label="Close Your computers"]');
  await evaluate('window.__model.devices[0].online=true;window.__model.aiReady=false;window.__model.emitDevices()');
  await eventually(()=>evaluate('document.body.innerText.includes("Your computer is connected. Set up an AI tool")'),"connected computer needs AI setup");
  await button("Set up AI");
  await eventually(()=>evaluate('!!document.querySelector(\'dialog[aria-label="Connect your AI"]\')'),"AI setup action");
  await click('button[aria-label="Close Connect your AI"]');
  await evaluate('window.__model.aiReady=true;window.__model.emitDevices()');
  await eventually(()=>evaluate('!document.querySelector(\'button[aria-label="Choose model"]\')?.disabled && !!document.querySelector(\'button[aria-label="Choose model"]\')'),"AI reconnects without reloading the page");
  await evaluate('window.__model.agentsFailure=true;window.__model.emitDevices()');
  await eventually(()=>evaluate('document.body.innerText.includes("We couldn’t check your AI tools")'),"AI discovery failure has a message");
  assert.ok(await evaluate('!!document.querySelector(".human-message")'),"AI discovery failure never hides saved chats");
  await evaluate('window.__model.agentsFailure=false;window.__model.emitDevices()');
  await eventually(()=>evaluate('!document.body.innerText.includes("We couldn’t check your AI tools")'),"AI discovery recovers");
  await click('button[aria-label="Add project"]');
  await click('button[aria-label="Start empty project"]');
  await type('dialog input',"Ideas and questions");
  await evaluate('window.__model.failCreate=true');
  await button("Create project");
  await eventually(()=>evaluate('!!document.querySelector("dialog [role=alert]")'),"empty project creation error is visible");
  assert.equal(await evaluate('document.querySelector("dialog input").value'),"Ideas and questions","failed creation preserves the name");
  await evaluate('window.__model.failCreate=false');
  await button("Create project");
  await eventually(()=>evaluate('!document.querySelector("dialog") && document.body.textContent.includes("What would you like to talk about?")'),"empty project opens a conversation");
  assert.equal(await evaluate('window.__model.repos.filter(repo=>repo.empty).length'),1);
  assert.ok(await evaluate('!!document.querySelector(\'button[aria-label="New chat in Ideas and questions"]\')'));
  assert.ok(await evaluate('document.body.textContent.includes("Files are optional")'));
  await button("Brainstorm an idea");
  assert.ok(await evaluate('document.querySelector(".ai-composer textarea").value.includes("brainstorm")'));
  assert.equal(await evaluate('document.querySelector(\'button[aria-label="Send message"]\').disabled'),false,"no files are required to send a prompt");
  assert.equal(await evaluate('window.__model.requests.filter(r=>r.path==="/api/ai/run").length'),0,"starters never send automatically");
  assert.equal(await evaluate('window.__model.requests.filter(r=>r.path.endsWith("/seed")).length'),0,"empty project needs no upload");
  for(const width of [1440,390]) {
    await send("Emulation.setDeviceMetricsOverride",{width,height:900,deviceScaleFactor:1,mobile:width===390});await delay(200);
    assert.ok(await evaluate('document.documentElement.scrollWidth <= innerWidth'),`empty conversation fits ${width}`);
    await writeFile(join(tmpdir(),`multiplayer-empty-project-${width}.png`),Buffer.from((await send("Page.captureScreenshot")).data,"base64"));
  }
  await send("Emulation.setDeviceMetricsOverride",{width:1440,height:900,deviceScaleFactor:1,mobile:false});
  await click('button[aria-label="Add project"]');await click('button[aria-label="Start empty project"]');
  await type('dialog input',"Ideas and questions");await button("Create project");
  await eventually(()=>evaluate('document.querySelector("dialog [role=alert]")?.textContent.includes("Choose another name")'),"duplicate name has actionable feedback");
  await button("Cancel");
  assert.deepEqual(errors,[]);
  assert.deepEqual(await evaluate("window.__model.unknown"),[]);
  console.log("PASS: empty-project creation, retry and duplicate errors, conversation starters, computer onboarding, offline chat access, connection and AI discovery recovery, back/forward save protection, chat drafts, repositories, queue routing, desktop/mobile layouts.");
  console.log("Unmocked requests:",await evaluate("window.__model.unknown"));
} catch (error) {
  try { console.log(await debugEvaluate?.(`JSON.stringify({body:document.body?.innerText,state:{unknown:window.__model?.unknown,requests:window.__model?.requests?.filter(r=>r.path!=="/api/presence")}})`)); }
  catch { console.log("Browser diagnostics unavailable."); }
  console.log(serverOutput.slice(-4000));
  throw error;
} finally {socket?.close();chrome.kill();if(server && server.exitCode===null){server.kill();await once(server,"exit").catch(()=>{});}}
