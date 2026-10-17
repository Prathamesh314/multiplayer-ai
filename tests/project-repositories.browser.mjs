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

import { installFixtures } from "./helpers/workspace-browser-fixture.mjs";

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
  const button = async text => {
    await eventually(()=>evaluate(`Array.from(document.querySelectorAll('button')).some(b=>b.textContent.trim()===${JSON.stringify(text)}&&!b.disabled)`),`button: ${text}`);
    return evaluate(`Array.from(document.querySelectorAll('button')).find(b=>b.textContent.trim()===${JSON.stringify(text)}&&!b.disabled).click()`);
  };
  await eventually(()=>evaluate('!!document.querySelector(\'button[aria-label="Add repository"]\')'),"empty room");
  await button("Start without files");
  await eventually(()=>evaluate('!!document.querySelector(\'dialog[aria-label="Start without files"] input\')'),"empty project available without any repository");
  assert.equal(await evaluate('Array.from(document.querySelectorAll("dialog button")).find(button=>button.textContent==="Create conversation space").disabled'),true,"empty project needs a name");
  await button("Cancel");
  await click('button[aria-label="Add repository"]');
  await button("Project repositories");
  await eventually(()=>evaluate('Array.from(document.querySelectorAll("dialog")).some(dialog=>dialog.innerText.includes("frontend"))'),"repository catalog");
  await button("Add to room");
  await eventually(()=>evaluate('document.body.innerText.includes("frontend.txt")'),"first repository without primary");
  assert.equal(await evaluate(`document.querySelectorAll('button[aria-label="New chat in frontend"]').length`),1);
  await click('button[aria-label="Add repository"]');
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
  // Working state: one composer-shaped card with the status inside, no separate bar.
  assert.ok(await evaluate(`[...document.querySelectorAll('[aria-label="Chat message queue"] [role=status]')].some(e=>e.textContent.includes("Codex is working"))`),"the status sits in the composer card");
  assert.equal(await evaluate(`[...document.querySelectorAll("aside div")].filter(e=>/is working…$/.test(e.textContent.trim())).length`),0,"no separate working bar");
  await writeFile(join(tmpdir(),'multiplayer-working-state.png'),Buffer.from((await send("Page.captureScreenshot")).data,"base64"));
  // The agent asks before opening a link; the driver answers in the chat.
  await evaluate(`window.__model.permissions={"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa":[{id:"cccccccc-cccc-4ccc-8ccc-cccccccccccc",turnId:"t",tool:"WebFetch",title:"WebFetch: https://docs.google.com/spreadsheets/d/x",detail:"{}",rule:"WebFetch(domain:docs.google.com)",status:"pending",remember:false,decidedBy:null,createdAt:Date.now()}]};window.__model.emit("run.permission",{runId:"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",at:Date.now()});`);
  await eventually(()=>evaluate(`[...document.querySelectorAll('section[aria-label="Tool requests"] button')].map(b=>b.textContent).join("|")==="Allow once|Always allow in this chat|Deny"`),"tool request with its choices");
  assert.ok(await evaluate(`document.querySelector('section[aria-label="Tool requests"]').textContent.includes("docs.google.com/spreadsheets")`));
  await evaluate(`[...document.querySelectorAll('section[aria-label="Tool requests"] button')].find(b=>b.textContent==="Always allow in this chat").click()`);
  await eventually(()=>evaluate(`!document.querySelector('section[aria-label="Tool requests"]') && JSON.stringify(window.__model.permissionDecisions)==='[{"id":"cccccccc-cccc-4ccc-8ccc-cccccccccccc","decision":"always"}]'`),"answer sent and the card cleared");
  assert.deepEqual(keyWarnings,[],"opening a chat has no React key warnings");
  await button('Share chat');
  await eventually(()=>evaluate('!!document.querySelector("dialog input[type=email]")'),"guest invitation dialog");
  await type('dialog input[type=email]','guest@example.test');
  await click('button[aria-label="Guest permission"]');
  await click('[role="option"][value="commenter"]');
  await button('Create invitation link');
  await eventually(()=>evaluate('!!document.querySelector("#chat-invite-link")'),"guest invitation created");
  assert.match(await evaluate('document.querySelector("#chat-invite-link").value'),/\/shared\/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa#invite=/);
  assert.equal(await evaluate('window.__model.invitations[0].role'),'commenter');
  await evaluate('window.__model.invitations[0].acceptedAt=new Date().toISOString()');
  await button('Done');await button('Share chat');
  await button('Allow guest to help with code…');
  await eventually(()=>evaluate('document.querySelector("dialog").innerText.includes("Join organization")'),'explicit access scope');
  assert.equal(await evaluate('Array.from(document.querySelectorAll("button")).find(b=>b.textContent==="Request admin approval").disabled'),true);
  await click('dialog input[type="checkbox"]');await button('Request admin approval');
  await eventually(()=>evaluate('document.querySelector("dialog").innerText.includes("Request sent to your organization")'),'admin request feedback');
  assert.equal(await evaluate('window.__model.accessGranted??false'),false,'request does not grant access');
  await button('Done');await evaluate('window.__model.canGrant=true');await button('Share chat');
  await button('Allow guest to help with code…');
  await eventually(()=>evaluate('Array.from(document.querySelectorAll("button")).some(b=>b.textContent==="Grant editing access")'),'authorized grant');
  await click('dialog input[type="checkbox"]');await button('Grant editing access');
  await eventually(()=>evaluate('document.querySelector("dialog").innerText.includes("Editing access granted.")'),'grant feedback');
  assert.equal(await evaluate('JSON.parse(window.__model.requests.filter(r=>r.method==="POST"&&r.path.endsWith("/access")).at(-1).body).scopeKey'),'confirmed-scope');
  await button('Revoke chat invitation');
  await eventually(()=>evaluate('document.querySelector("dialog").innerText.includes("Access removed")'),"guest access removed");
  assert.equal(await evaluate('document.querySelector("#chat-invite-link")'),null);
  await button('Done');
  await button('Feedback · 1 unread');
  await eventually(()=>evaluate('document.querySelector("dialog").innerText.includes("Please check delivery errors.")'),'guest feedback in the workspace');
  await type('#conversation-feedback','I will check that before handing off.');
  await evaluate('window.__model.failFeedback=true');await button('Post reply');
  await eventually(()=>evaluate('document.querySelector("dialog [role=alert]")?.textContent.includes("Could not post feedback")'),'feedback delivery failure');
  assert.equal(await evaluate('document.querySelector("#conversation-feedback").value'),'I will check that before handing off.');
  await evaluate('window.__model.failFeedback=false');await button('Post reply');
  await eventually(()=>evaluate('document.querySelector("#conversation-feedback").value===""&&document.querySelector("dialog").innerText.includes("I will check that before handing off.")'),'direct host reply');
  await click('button[aria-label="Close Conversation feedback"]');
  await evaluate('for(let i=0;i<60;i++)window.__model.feedback.push({id:crypto.randomUUID(),seq:window.__model.feedback.length+1,body:"Earlier feedback "+i,authorName:"Guest",createdAt:new Date().toISOString()});document.dispatchEvent(new Event("visibilitychange"))');
  await button('Feedback · 60 unread');
  await button('Load earlier feedback');
  await eventually(()=>evaluate('window.__model.feedbackRead===62'),'read loaded feedback history');
  await evaluate('for(let i=0;i<65;i++)window.__model.feedback.push({id:crypto.randomUUID(),seq:window.__model.feedback.length+1,body:"New burst "+i,authorName:"Guest",createdAt:new Date().toISOString()});document.dispatchEvent(new Event("visibilitychange"))');
  await eventually(()=>evaluate('document.querySelector("dialog").innerText.includes("New burst 64")'),'new feedback burst');
  assert.equal(await evaluate('window.__model.feedbackRead'),62,'unseen gap stays unread');
  await button('Load earlier feedback');
  await eventually(()=>evaluate('document.querySelector("dialog").innerText.includes("New burst 0")'),'missing feedback fetched');
  await button('Load earlier feedback');
  await eventually(()=>evaluate('window.__model.feedbackRead===127'),'complete feedback history marked read');
  await click('button[aria-label="Close Conversation feedback"]');
  const queue='textarea[aria-label="Message working agent"]';
  await type(queue,"Keep this unsent instruction in chat A");
  await button("Handoff");
  await eventually(()=>evaluate('!!document.querySelector("dialog textarea")'),"handoff form");
  assert.ok(await evaluate('[...document.querySelectorAll("dialog[open] .ui-dialog-body")].every(el=>el.scrollWidth<=el.clientWidth+1)'),"handoff fields fit the dialog inside the file toolbar");
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
  assert.deepEqual(await evaluate(`Array.from(document.querySelector('.file-actions').querySelectorAll('button')).map(button=>button.textContent.trim())`), ["Assign Tasks", "Handoff", "Ask AI to review"]);
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
  await click('button[aria-label="Add repository"]');
  await click('button[aria-label="Start without files"]');
  await type('dialog input',"Ideas and questions");
  await evaluate('window.__model.failCreate=true');
  await button("Create conversation space");
  await eventually(()=>evaluate('!!document.querySelector("dialog [role=alert]")'),"empty project creation error is visible");
  assert.equal(await evaluate('document.querySelector("dialog input").value'),"Ideas and questions","failed creation preserves the name");
  await evaluate('window.__model.failCreate=false');
  await button("Create conversation space");
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
  await click('button[aria-label="Add repository"]');await click('button[aria-label="Start without files"]');
  await type('dialog input',"Ideas and questions");await button("Create conversation space");
  await eventually(()=>evaluate('document.querySelector("dialog [role=alert]")?.textContent.includes("Choose another name")'),"duplicate name has actionable feedback");
  await button("Cancel");
  // Adding files to the empty project, VS Code style: New file, then several
  // files dropped at once, with a replace prompt for one that already exists.
  assert.ok(await evaluate(`document.body.textContent.includes("Upload files")`),"the empty project says how to add files");
  await click('button[aria-label="New file"]');
  await eventually(()=>evaluate(`!!document.querySelector('input[aria-label="New file path"]')`),"new file name box");
  await type('input[aria-label="New file path"]',"data/report.csv");
  await evaluate(`document.querySelector('input[aria-label="New file path"]').form.requestSubmit()`);
  await eventually(()=>evaluate(`JSON.stringify(window.__model.uploads?.[0]?.paths)==='["data/report.csv"]'`),"new file created");
  await eventually(()=>evaluate(`!document.querySelector('input[aria-label="New file path"]') && document.body.textContent.includes("data/report.csv")`),"new file in the tree");
  await evaluate(`(()=>{const dt=new DataTransfer();dt.items.add(new File(["name,score\\nalice,3\\n"],"scores.csv",{type:"text/csv"}));dt.items.add(new File(["fresh"],"report.csv",{type:"text/csv"}));
    const zone=document.querySelector('aside[aria-label="Repository explorer"] .vs-scroll.flex-1');zone.dispatchEvent(new DragEvent("dragover",{bubbles:true,cancelable:true,dataTransfer:dt}));zone.dispatchEvent(new DragEvent("drop",{bubbles:true,cancelable:true,dataTransfer:dt}));})()`);
  await eventually(()=>evaluate(`!!document.querySelector('input[aria-label="Destination folder"]')`),"upload dialog for dropped files");
  await type('input[aria-label="Destination folder"]',"data");
  await eventually(()=>evaluate(`document.querySelector('ul[aria-label="Files to add"]').textContent.includes("replaces existing")`),"the existing file is flagged");
  await button("Add 2 files");
  await eventually(()=>evaluate(`[...document.querySelectorAll('[role=alert]')].some(e=>e.textContent.includes("data/report.csv already exists"))`),"asks before replacing");
  assert.equal(await evaluate(`window.__model.uploads.length`),1,"nothing is sent before confirming");
  await button("Replace 1 and add");
  await eventually(()=>evaluate(`window.__model.uploads.length===2 && window.__model.uploads[1].overwrite===true && JSON.stringify(window.__model.uploads[1].paths)==='["data/scores.csv","data/report.csv"]'`),"both files sent together, replacing confirmed");
  await eventually(()=>evaluate(`!document.querySelector('input[aria-label="Destination folder"]') && document.body.textContent.includes("data/scores.csv")`),"dialog closes and the tree shows them");
  assert.ok(await evaluate(`!document.body.textContent.includes("Drop a folder, not a single file")`),"a drop on the explorer is not taken as a project-folder import");
  await writeFile(join(tmpdir(),'multiplayer-explorer-add.png'),Buffer.from((await send("Page.captureScreenshot")).data,"base64"));
  // A live run: waiting for the computer, then the agent's steps with readable
  // names, and the working status inside the composer card.
  await evaluate(`window.__model.runs.push({id:"dddddddd-dddd-4ddd-8ddd-dddddddddddd",sessionId:"modelroomabc",repoId:window.__model.repos.at(-1)?.id??null,startedBy:"alice",startedByName:"Alice",driverUserId:"alice",driverName:"Alice",controlVersion:0,agentId:"codex",title:"Live run",status:"running",baseSha:"a".repeat(40),createdAt:Date.now(),startedAt:Date.now(),endedAt:null,archivedAt:null});
    window.__model.runEvents=[{t:"notice",message:"Queued for your runner. No agent has started yet."},{wait:900},{t:"start",agent:"codex",cwd:"/w",runId:"dddddddd-dddd-4ddd-8ddd-dddddddddddd"},{t:"act",d:"ToolSearch"},{t:"act",d:"mcp__claude_ai_Google_Drive__read_file_content"}];`);
  await evaluate(`document.querySelector('button[aria-label="Send message"]').click()`);
  await eventually(()=>evaluate(`[...document.querySelectorAll('[role=status]')].some(e=>e.textContent.includes("Waiting for your computer to start"))`),"a soft waiting pill while the computer picks it up");
  await writeFile(join(tmpdir(),'multiplayer-run-waiting.png'),Buffer.from((await send("Page.captureScreenshot")).data,"base64"));
  await eventually(()=>evaluate(`document.body.textContent.includes("Google Drive · Read file content") && document.body.textContent.includes("Look up tools")`),"steps read as plain language");
  assert.ok(await evaluate(`!document.body.textContent.includes("Waiting for your computer") && !document.body.textContent.includes("No agent has started yet")`),"the waiting pill gives way once the agent starts");
  assert.ok(await evaluate(`!document.body.textContent.includes("mcp__claude_ai")`),"no raw tool identifiers");
  await eventually(()=>evaluate(`[...document.querySelectorAll('[role=status]')].some(e=>e.textContent.includes("Codex is working"))`),"working status in the composer card");
  await writeFile(join(tmpdir(),'multiplayer-run-steps.png'),Buffer.from((await send("Page.captureScreenshot")).data,"base64"));
  assert.deepEqual(errors,[]);
  assert.deepEqual(await evaluate("window.__model.unknown"),[]);
  console.log("PASS: conversation-space creation, retry and duplicate errors, conversation starters, computer onboarding, offline chat access, connection and AI discovery recovery, back/forward save protection, chat drafts, repositories, queue routing, desktop/mobile layouts.");
  console.log("Unmocked requests:",await evaluate("window.__model.unknown"));
} catch (error) {
  try { console.log(await debugEvaluate?.(`JSON.stringify({body:document.body?.innerText,state:{unknown:window.__model?.unknown,requests:window.__model?.requests?.filter(r=>r.path!=="/api/presence")}})`)); }
  catch { console.log("Browser diagnostics unavailable."); }
  console.log(serverOutput.slice(-4000));
  throw error;
} finally {socket?.close();chrome.kill();if(server && server.exitCode===null){server.kill();await once(server,"exit").catch(()=>{});}}
