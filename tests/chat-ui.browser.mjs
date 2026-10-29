/** Browser checks of the real workspace UI with isolated, in-browser API fixtures.
 * npm run build -- --webpack && npm run test:ui
 * No fixture request reaches the app's database. To use an existing server:
 * CHAT_UI_BASE_URL=http://localhost:3100 node tests/chat-ui.browser.mjs
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";

const startServer = process.argv.includes("--start-server");
const base = process.env.CHAT_UI_BASE_URL ?? "http://127.0.0.1:3107";
let serverOutput = "";
const server = startServer ? spawn(process.execPath, ["node_modules/next/dist/bin/next", "start", "--hostname", "127.0.0.1", "--port", new URL(base).port], {stdio:["ignore","pipe","pipe"]}) : null;
server?.stdout.on("data", data => { serverOutput += data; });
server?.stderr.on("data", data => { serverOutput += data; });
const directory = await mkdtemp(join(tmpdir(), "multiplayer-chat-ui-"));
const chrome = spawn(process.env.CHROME_BIN ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", [
  "--headless=new", "--disable-gpu", "--no-first-run", "--no-default-browser-check",
  "--remote-debugging-port=9336", `--user-data-dir=${directory}`, "about:blank",
], { stdio: ["ignore", "ignore", "pipe"] });
let chromeOutput = "";
chrome.stderr.on("data", data => { chromeOutput = (chromeOutput + data).slice(-4000); });
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function eventually(task, label, attempts = 100) {
  for (let i = 0; i < attempts; i++) { if (await task()) return; await delay(100); }
  throw new Error(`Timed out: ${label}`);
}

import { installFixtures } from "./helpers/team-browser-fixture.mjs";

let socket;
try {
  if (server) await eventually(async()=>{if(server.exitCode!==null) throw Error(serverOutput);try{return (await fetch(base+"/login")).ok;}catch{return false;}},"preview server");
  let targets;
  // A cold browser on a busy CI runner can take well over ten seconds to open
  // its debugging port. Wait as long as the other browser suites do, and stop
  // at once with Chrome's own output if it exits instead.
  await eventually(async()=>{if(chrome.exitCode!==null)throw Error(`Chrome exited (${chrome.exitCode}): ${chromeOutput}`);try {targets=await (await fetch("http://127.0.0.1:9336/json")).json();return targets.length;}catch{return false;}},"browser",300);
  socket = new WebSocket(targets.find(target=>target.type==="page").webSocketDebuggerUrl);
  await once(socket,"open");
  let sequence=0; const pending=new Map();const errors=[];
  socket.onmessage=event=>{
    const message=JSON.parse(event.data);
    if(message.method==="Runtime.exceptionThrown")errors.push(message.params.exceptionDetails.text);
    const operation=pending.get(message.id);
    if(operation){pending.delete(message.id);clearTimeout(operation.timer);if(message.error)operation.reject(message.error);else operation.resolve(message.result);}
  };
  const send=(method,params={})=>new Promise((resolve,reject)=>{const id=++sequence;const timer=setTimeout(()=>{pending.delete(id);reject(Error(`CDP timeout: ${method}`));},15000);pending.set(id,{resolve,reject,timer});socket.send(JSON.stringify({id,method,params}));});
  const evaluate=async expression=>{const result=await send("Runtime.evaluate",{expression,returnByValue:true,awaitPromise:true});if(result.exceptionDetails)throw Error(JSON.stringify(result.exceptionDetails));return result.result.value;};
  const click=async selector=>{assert.ok(await evaluate(`!!document.querySelector(${JSON.stringify(selector)})`),selector);await evaluate(`(()=>{const control=document.querySelector(${JSON.stringify(selector)});control.focus();control.click();})()`);await delay(80);};
  const type=async(selector,value)=>{await evaluate(`(()=>{const el=document.querySelector(${JSON.stringify(selector)});Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el),'value').set.call(el,${JSON.stringify(value)});el.dispatchEvent(new Event('input',{bubbles:true}));})()`);await delay(80);};
  await send("Page.enable");await send("Runtime.enable");
  await send("Emulation.setEmulatedMedia", {features:[{name:"prefers-color-scheme",value:"dark"}]});
  const screenshot=async name=>{
    await evaluate('Promise.all(Array.from(document.querySelectorAll(".composer-picker")).flatMap(el=>el.getAnimations()).map(animation=>animation.finished.catch(()=>{})))');
    await writeFile(join(tmpdir(), `multiplayer-ui-${name}.png`),Buffer.from((await send("Page.captureScreenshot")).data,"base64"));
  };
  const viewport=async(width,height=900)=>{await send("Emulation.setDeviceMetricsOverride",{width,height,deviceScaleFactor:1,mobile:false});await delay(200);};
  const fits=async label=>assert.ok(await evaluate("document.documentElement.scrollWidth <= innerWidth"),label);
  const orgAction=async label=>{await click('button[aria-label="Switch team"]');await eventually(()=>evaluate(`[...document.querySelectorAll("[role=menu] [role=menuitem]")].some(e=>e.textContent.trim()===${JSON.stringify(label)})`),label);await evaluate(`[...document.querySelectorAll("[role=menu] [role=menuitem]")].find(e=>e.textContent.trim()===${JSON.stringify(label)}).click()`);await delay(80);};
  const escape=async()=>{await send("Input.dispatchKeyEvent",{type:"keyDown",key:"Escape",code:"Escape",windowsVirtualKeyCode:27});await send("Input.dispatchKeyEvent",{type:"keyUp",key:"Escape",code:"Escape",windowsVirtualKeyCode:27});};
  const mouseClick=async selector=>{
    await evaluate(`document.querySelector(${JSON.stringify(selector)}).scrollIntoView({block:'nearest'})`);
    let point;
    await eventually(async()=>{point=await evaluate(`(()=>{const el=document.querySelector(${JSON.stringify(selector)}),r=el.getBoundingClientRect(),x=r.left+r.width/2,y=r.top+r.height/2;return el.contains(document.elementFromPoint(x,y))?{x,y}:null;})()`);return point;},`unobscured ${selector}`);
    await send('Input.dispatchMouseEvent',{type:'mousePressed',...point,button:'left',clickCount:1});
    await send('Input.dispatchMouseEvent',{type:'mouseReleased',...point,button:'left',clickCount:1});
  };
  await send("Page.addScriptToEvaluateOnNewDocument",{source:`(${installFixtures.toString()})()`});
  await send("Emulation.setDeviceMetricsOverride",{width:1440,height:900,deviceScaleFactor:1,mobile:false});
  await send("Page.navigate",{url:base+"/workspace"});
  await eventually(()=>evaluate('!!document.querySelector("#projects-heading") && !!document.querySelector("main article")'),"project overview");
  // One action queue: handoffs, tasks and collaboration requests, each list loaded without errors.
  await eventually(()=>evaluate('(q=>!!q && !q.innerText.includes("Checking what needs you") && !q.querySelector("[role=alert]"))(document.querySelector(\'[aria-label="Action queue"]\'))'),"action queue loaded without errors");
  assert.ok(await evaluate('document.querySelector("#projects-heading").getBoundingClientRect().top < document.querySelector("#workflow-heading").getBoundingClientRect().top'),"projects precede onboarding help");
  assert.equal(await evaluate(`getComputedStyle(document.documentElement).getPropertyValue("--vs-editor").trim()`),"#141210","project overview shares the session palette");
  await evaluate("document.fonts.ready");await screenshot("projects");
  // Handoffs wait on the dashboard: what you can accept, and what you sent.
  await eventually(()=>evaluate('document.querySelector("#handoffs")?.innerText.includes("Priya Shah handed you Checkout polish")'),"a handoff waiting for you");
  assert.ok(await evaluate('document.querySelector("#handoffs").innerText.includes("Copy is done; please wire the analytics.") && document.querySelector("#handoffs").innerText.includes("Cart totals")'),"the note and your own sent offer");
  assert.ok(await evaluate(`[...document.querySelectorAll('#workspace-navigation button')].some(b=>b.textContent.includes("Project overview")&&b.textContent.includes("1"))`),"the sidebar counts handoffs waiting for you");
  assert.equal(await evaluate('[...document.querySelectorAll(\'[aria-label="Action queue"] [role=tabpanel] section\')][0]?.id'),"handoffs","handoffs come first: they expire");
  assert.ok(await evaluate(`[...document.querySelectorAll('[aria-label="Action queue"] [role=tab]')].some(t=>t.textContent.startsWith("Handoffs")&&t.textContent.endsWith("1"))`),"the Handoffs tab counts what waits for you");
  // Each tab shows one list; the others keep loading behind it.
  await evaluate(`[...document.querySelectorAll('[aria-label="Action queue"] [role=tab]')].find(t=>t.textContent.startsWith("Collaboration")).click()`);
  await eventually(()=>evaluate('document.querySelector(\'[aria-label="Collaboration inbox"]\')?.innerText.includes("You’re caught up.") && !document.querySelector("#handoffs").checkVisibility()'),"collaboration tab");
  await evaluate(`[...document.querySelectorAll('[aria-label="Action queue"] [role=tab]')].find(t=>t.textContent.startsWith("Action queue")).click()`);
  await screenshot('handoffs');
  await evaluate('[...document.querySelectorAll("#handoffs button")].find(b=>b.textContent.trim()==="Decline").click()');
  await eventually(()=>evaluate('JSON.stringify(window.__chatFixture.handoffActions?.[0])===JSON.stringify({action:"decline",handoffId:"h-received",version:3}) && !document.querySelector("#handoffs").innerText.includes("Checkout polish")'),"declining sends the chat’s version and clears it");
  // One sidebar: the organisation switcher on top, the signed-in person at the bottom, no rail.
  const switcher='button[aria-label="Switch team"]';
  assert.equal(await evaluate('document.querySelector(\'nav[aria-label="Organisations"]\')'),null,"the organisation rail is gone");
  assert.ok(await evaluate(`document.querySelector('${switcher}').innerText.includes("Northstar Studio") && document.querySelector('${switcher}').innerText.includes("Owner")`),"the switcher names the organisation and your role");
  await click(switcher);
  await eventually(()=>evaluate('document.activeElement?.getAttribute("aria-label") === "Search teams"'),"organization search receives focus");
  assert.equal(await evaluate('document.querySelector(\'[role=menu][aria-label="Teams"] [role=menuitemradio][aria-checked="true"]\').title'),"Northstar Studio","the current organization is checked");
  await type('input[aria-label="Search teams"]','not-my-team');
  await eventually(()=>evaluate('document.querySelector(\'[role=menu] [role=status]\')?.textContent.includes("No teams found")'),"organization search empty result");
  await type('input[aria-label="Search teams"]','  sIdE pRoJeCtS  ');
  assert.equal(await evaluate('document.querySelectorAll("[role=menu] [role=menuitemradio]").length'),1);
  await screenshot('organization-switcher');
  await send('Input.dispatchKeyEvent',{type:'keyDown',key:'Enter',code:'Enter',windowsVirtualKeyCode:13,text:'\r'});
  await send('Input.dispatchKeyEvent',{type:'keyUp',key:'Enter',code:'Enter',windowsVirtualKeyCode:13});
  await eventually(()=>evaluate('document.querySelector("main h1")?.textContent === "Side Projects"'),"search opens the selected organization");
  assert.equal(await evaluate('document.activeElement?.getAttribute("aria-label")'),"Switch team","selection returns focus to the switcher");
  assert.ok(await evaluate(`document.querySelector('${switcher}').innerText.includes("Member")`),"the role follows the organisation");
  // Ctrl/⌘+1…9 jump straight to an organisation.
  await send('Input.dispatchKeyEvent',{type:'keyDown',key:'1',code:'Digit1',windowsVirtualKeyCode:49,modifiers:2});
  await send('Input.dispatchKeyEvent',{type:'keyUp',key:'1',code:'Digit1',windowsVirtualKeyCode:49,modifiers:2});
  await eventually(()=>evaluate('document.querySelector("main h1")?.textContent === "Northstar Studio"'),"keyboard shortcut switches organisations");
  // The current organisation's own actions live in the switcher, for those who manage it.
  await click(switcher);
  assert.deepEqual(await evaluate('[...document.querySelectorAll("[role=menu][aria-label=Teams] [role=menuitem]")].map(e=>e.textContent.trim())'),
    ["Team settings","Members & admin","Invite to team","Create team","Join a team"]);
  await escape();
  await eventually(()=>evaluate('!document.querySelector("[role=menu]") && document.activeElement?.getAttribute("aria-label")==="Switch team"'),"Escape closes the switcher and keeps focus");
  // The signed-in person sits at the bottom of the same sidebar and opens the account menu.
  const account='[aria-label="Your account"]';
  assert.ok(await evaluate(`document.querySelector(${JSON.stringify(account)}).innerText.includes("Alex Chen")&&document.querySelector(${JSON.stringify(account)}).innerText.includes("@alex")`),"profile names the signed-in person");
  for(const label of ['AI providers','Your computers']) assert.ok(await evaluate(`!!document.querySelector(${JSON.stringify(account+' button[aria-label="'+label+'"]')})`),label+" shortcut stays on the card");
  await click(`${account} button[aria-haspopup="menu"]`);
  await eventually(()=>evaluate('!!document.querySelector("[role=menu]")'),"account menu opens from the profile card");
  for(const label of ['AI providers','Your computers','Your AI tools','Account settings','Sign out']) assert.ok(await evaluate(`document.querySelector("[role=menu]").innerText.includes(${JSON.stringify(label)})`),label+" stays reachable");
  await screenshot('sidebar');
  await escape();
  await eventually(()=>evaluate('!document.querySelector("[role=menu]")'),"Escape closes the account menu");
  // Phones: the sidebar is a drawer opened from a slim top bar.
  await viewport(390);
  assert.equal(await evaluate('getComputedStyle(document.querySelector("#workspace-navigation")).display'),"none","the drawer starts closed");
  await click('button[aria-label="Open navigation"]');
  await eventually(()=>evaluate('getComputedStyle(document.querySelector("#workspace-navigation")).display==="flex"'),"the drawer opens");
  await click(switcher);
  await eventually(()=>evaluate('!!document.querySelector("[role=menu][aria-label=Teams]")'),"mobile organization switcher");
  await fits('organization switcher fits mobile');
  assert.ok(await evaluate('(()=>{const r=document.querySelector("[role=menu][aria-label=Teams]").getBoundingClientRect();return r.left>=0&&r.right<=innerWidth;})()'));
  await screenshot('organizations-mobile');
  await escape();
  assert.equal(await evaluate('getComputedStyle(document.querySelector("#workspace-navigation")).display'),"flex","Escape in the switcher keeps the drawer open");
  await click(`${account} button[aria-haspopup="menu"]`);
  await eventually(()=>evaluate('!!document.querySelector("[role=menu]")'),"account menu opens on a phone");
  const entries=await evaluate(`[...document.querySelectorAll("[role=menu] [role=menuitem]")].map(e=>{const r=e.getBoundingClientRect();return {text:e.innerText.trim(),width:r.width,height:r.height};})`);
  assert.deepEqual(entries.map(e=>e.text),["AI providers","Your computers","Your AI tools","Account settings","Sign out"]);
  for(const entry of entries){assert.ok(entry.height<=44,`${entry.text} stays on one line (${entry.height}px tall)`);assert.ok(entry.width>=180,`${entry.text} is not squeezed (${entry.width}px wide)`);}
  assert.ok(await evaluate('(()=>{const r=document.querySelector("[role=menu]").getBoundingClientRect();return r.left>=0&&r.right<=innerWidth&&r.top>=0;})()'),"the menu fits the screen");
  await screenshot('account-menu-mobile');
  // Personal AI tools open from the account menu, as a dialog that fits a phone.
  await evaluate('[...document.querySelectorAll("[role=menu] [role=menuitem]")].find(e=>e.innerText.trim()==="Your AI tools").click()');
  await eventually(()=>evaluate('document.querySelector("dialog[open]")?.innerText.includes("No tools yet")'),"personal AI tools dialog");
  await fits("personal AI tools on a phone");
  await escape();
  await eventually(()=>evaluate('!document.querySelector("dialog")'),"personal AI tools close");
  await escape();
  await eventually(()=>evaluate('getComputedStyle(document.querySelector("#workspace-navigation")).display==="none"'),"Escape closes the drawer");
  await viewport(320);
  await viewport(1440);
  console.log('PASS: organization switcher with search, roles, keyboard shortcuts and organisation actions; profile menu; phone drawer and mobile bounds.');
  await orgAction('Team settings');
  await eventually(()=>evaluate('!!document.querySelector("dialog[open] input[type=text]")'),"settings dialog");
  await type('dialog input[type=text]',"Northstar Studio");
  await viewport(390,620);
  await fits("settings fit mobile");
  assert.ok(await evaluate('(()=>{const d=document.querySelector("dialog");const f=d.querySelector("footer").getBoundingClientRect();const b=d.querySelector(".ui-dialog-body");return f.bottom<=innerHeight && f.top>0 && b.clientHeight>0 && b.scrollHeight>=b.clientHeight;})()'),"dialog scrolls independently with actions visible");
  for(let i=0;i<12;i++)await send("Input.dispatchKeyEvent",{type:"keyDown",key:"Tab",code:"Tab",windowsVirtualKeyCode:9});
  assert.ok(await evaluate('document.querySelector("dialog").contains(document.activeElement)'),"keyboard focus stays in modal");
  await screenshot("settings-mobile");
  await viewport(320,300);
  assert.ok(await evaluate('(()=>{const body=document.querySelector(".ui-dialog-body");const footer=document.querySelector("dialog footer");return body.scrollHeight>body.clientHeight && body.clientHeight>0 && body.scrollWidth<=body.clientWidth && footer.getBoundingClientRect().bottom<=innerHeight;})()'),"short dialogs keep actions visible and scroll the form");
  await click('dialog button[type=submit]');
  await eventually(()=>evaluate('!document.querySelector("dialog")'),"settings save preserved");
  await viewport(1440);
  // Real pointer/keyboard interaction catches menus rendered behind a native
  // modal, which calling element.click() would silently bypass.
  await click('button[title="View members & manage roles"]');
  await eventually(()=>evaluate('!!document.querySelector(\'button[aria-label="Role for Priya Shah"]\')'),'project members');
  assert.equal(await evaluate('document.querySelectorAll("dialog select, dialog datalist").length'),0);
  assert.equal(await evaluate('!!document.querySelector(\'button[aria-label="Role for Alex Chen"]\')'),false,'self role stays read-only');
  await mouseClick('button[aria-label="Role for Priya Shah"]');
  await eventually(()=>evaluate('!!document.querySelector("dialog .composer-picker:popover-open")'),'picker above modal');
  assert.ok(await evaluate(`(()=>{const p=document.querySelector('.composer-picker').getBoundingClientRect(),t=document.querySelector('button[aria-label="Role for Priya Shah"]').getBoundingClientRect();return p.bottom<t.top&&p.top>=0;})()`),'member menu opens upward');
  await screenshot('project-members-picker');
  await escape();
  assert.ok(await evaluate('!!document.querySelector("dialog[open]") && !document.querySelector(".composer-picker")'),'Escape closes picker without closing parent');
  assert.equal(await evaluate('document.activeElement.getAttribute("aria-label")'),'Role for Priya Shah');
  await mouseClick('button[aria-label="Role for Priya Shah"]');
  await mouseClick('.composer-picker [role="option"][value="editor"]');
  await eventually(()=>evaluate('document.querySelector(\'button[aria-label="Role for Priya Shah"]\')?.textContent==="Editor"'),'project role saved');
  assert.equal(await evaluate('window.__chatFixture.memberWrites.at(-1).role'),'editor');
  await evaluate('window.__chatFixture.failNext=true');
  await mouseClick('button[aria-label="Role for Priya Shah"]');
  await mouseClick('.composer-picker [role="option"][value="viewer"]');
  await eventually(()=>evaluate('document.querySelector("dialog [role=alert]")?.textContent.includes("Could not change that role")'),'role failure visible');
  assert.equal(await evaluate('document.querySelector(\'button[aria-label="Role for Priya Shah"]\').textContent'),'Editor','failed save retains the saved role');
  await mouseClick('button[aria-label="Role for new project members"]');
  await eventually(()=>evaluate('document.activeElement?.getAttribute("role")==="option"'),'keyboard focus enters member picker');
  await send('Input.dispatchKeyEvent',{type:'keyDown',key:'End',code:'End',windowsVirtualKeyCode:35});
  assert.equal(await evaluate('document.activeElement.value'),'viewer','End focuses the last role');
  await send('Input.dispatchKeyEvent',{type:'keyDown',key:'Enter',code:'Enter',windowsVirtualKeyCode:13,text:'\r'});
  await send('Input.dispatchKeyEvent',{type:'keyUp',key:'Enter',code:'Enter',windowsVirtualKeyCode:13});
  await eventually(()=>evaluate('!document.querySelector(".composer-picker")'),'keyboard selection closes menu');
  assert.equal(await evaluate('document.querySelector(\'button[aria-label="Role for new project members"]\').textContent'),'Viewer');
  await evaluate('Array.from(document.querySelectorAll("dialog li")).find(li=>li.textContent.includes("Sam Rivera")).querySelector("button").click()');
  await eventually(()=>evaluate('window.__chatFixture.memberWrites.some(write=>write.userId==="sam"&&write.role==="viewer")'),'new member uses chosen role');
  for (const width of [390,320]) {
    await viewport(width,560);
    await mouseClick('button[aria-label="Role for new project members"]');
    assert.ok(await evaluate(`(()=>{const p=document.querySelector('.composer-picker').getBoundingClientRect();return p.left>=0&&p.right<=innerWidth&&p.top>=0&&p.bottom<=innerHeight;})()`),`picker fits viewport ${width}`);
    await fits(`member dialog at ${width}`);
    if(width===390)await screenshot('project-members-mobile');
    await escape();
  }
  await viewport(1440);
  await escape();
  await orgAction('Members & admin');
  await eventually(()=>evaluate('!!document.querySelector(\'button[aria-label="Role for Priya Shah"]\')'),'organisation members');
  await mouseClick('button[aria-label="Role for Priya Shah"]');
  await mouseClick('.composer-picker [role="option"][value="admin"]');
  await eventually(()=>evaluate('document.querySelector(\'button[aria-label="Role for Priya Shah"]\')?.textContent==="Admin"'),'organisation role saved');
  await escape();
  console.log('PASS: modern role pickers support pointer/keyboard, modal focus, failed saves, member creation and mobile bounds.');
  await click('button[title="New project"]');
  await eventually(()=>evaluate('!!document.querySelector("dialog[open] input")'),"new project dialog");
  await escape();
  await eventually(()=>evaluate('!document.querySelector("dialog")'),"Escape closes dialog");
  await orgAction('Team settings');
  await escape();
  assert.equal(await evaluate('document.activeElement.getAttribute("aria-label")'),"Switch team","modal restores focus to the switcher");
  await viewport(390);
  await fits("project overview fits mobile");await screenshot("projects-mobile");
  await viewport(1440);
  assert.equal(await evaluate('!!document.querySelector("textarea")'),false,'human chat is removed from project workspace');
  await evaluate('Array.from(document.querySelectorAll("button")).find(b=>b.textContent.trim()==="Connections").click()');
  await eventually(()=>evaluate('document.body.innerText.includes("Northstar Slack")'),'project connections');
  assert.ok(await evaluate('Array.from(document.querySelectorAll("button")).find(b=>b.textContent.includes("Connect Discord")).disabled'),'unconfigured provider is honestly disabled');
  assert.ok(await evaluate('document.body.innerText.includes("15 messages")'));
  await screenshot('connections');
  await evaluate('Array.from(document.querySelectorAll("button")).find(b=>b.textContent.trim()==="Choose channels").click()');
  await eventually(()=>evaluate('!!document.querySelector("dialog input[type=search]")'),'channel picker');
  await type('input[aria-label="Search channels"]','product');
  assert.equal(await evaluate('Array.from(document.querySelectorAll("dialog label")).filter(el=>el.textContent.includes("#engineering")).length'),0);
  await evaluate('Array.from(document.querySelectorAll("dialog label")).find(el=>el.textContent.includes("#product-design")).querySelector("input").click()');
  assert.ok(await evaluate('Array.from(document.querySelectorAll("dialog button")).find(b=>b.textContent.includes("Save channels")).disabled'),'sharing consent required');
  await evaluate('Array.from(document.querySelectorAll("dialog label")).find(el=>el.textContent.includes("authorised")).querySelector("input").click()');
  await evaluate('window.__chatFixture.failNext=true;Array.from(document.querySelectorAll("dialog button")).find(b=>b.textContent.includes("Save channels")).click()');
  await eventually(()=>evaluate('document.querySelector("dialog").innerText.includes("Could not save channels")'),'save error visible in picker');
  assert.equal(await evaluate('document.querySelectorAll("dialog input[type=checkbox]:checked").length'),2,'selection and consent survive failed save');
  await evaluate('Array.from(document.querySelectorAll("dialog button")).find(b=>b.textContent.includes("Save channels")).click()');
  await eventually(()=>evaluate('!document.querySelector("dialog") && document.body.innerText.includes("2 selected channels")'),'channels saved');
  for(const width of [768,390,320]){await viewport(width);await fits(`connections at ${width}`);if(width===390)await screenshot('connections-mobile');}
  await viewport(1440);
  // AI tools: a teammate's MCP server waits for Alex to allow it; a preset adds one that needs a key.
  const button=text=>`Array.from(document.querySelectorAll("button")).find(b=>b.textContent.trim()===${JSON.stringify(text)})`;
  await eventually(()=>evaluate('document.body.innerText.includes("context7") && document.body.innerText.includes("Not allowed on your computer yet")'),'project AI tools');
  await evaluate(`${button("Allow on my computer")}.click()`);
  await eventually(()=>evaluate('!document.body.innerText.includes("Not allowed on your computer yet") && document.body.innerText.includes("Stop allowing")'),'tool allowed');
  await evaluate(`${button("Add tool")}.click()`);
  await eventually(()=>evaluate('!!document.querySelector("dialog[open]")'),'add tool dialog');
  await evaluate('Array.from(document.querySelectorAll("dialog button")).find(b=>b.textContent.trim()==="GitHub").click()');
  await eventually(()=>evaluate('document.querySelector("dialog input").value==="github"'),'preset fills the form');
  assert.match(await evaluate('document.querySelector("dialog textarea").value'),/Authorization: Bearer \$\{GITHUB_TOKEN\}/);
  await evaluate('Array.from(document.querySelectorAll("dialog footer button")).find(b=>b.textContent.trim()==="Add tool").click()');
  await eventually(()=>evaluate('!document.querySelector("dialog") && document.body.innerText.includes("Add GITHUB_TOKEN")'),'tool added and needs a key');
  const added=await evaluate('window.__chatFixture.toolWrites.find(write=>write.method==="POST"&&!write.toolId).body');
  assert.deepEqual(added,{name:'github',kind:'mcp',spec:{transport:'http',url:'https://api.githubcopilot.com/mcp/',headers:[{name:'Authorization',value:'Bearer ${GITHUB_TOKEN}'}]}},'definitions carry key names, never keys');
  await evaluate(`${button("Add GITHUB_TOKEN")}.click()`);
  await eventually(()=>evaluate('document.querySelector("dialog[open]")?.innerText.includes("multicode-ai-runner secret set GITHUB_TOKEN")'),'keys stay on the computer');
  await escape();
  await eventually(()=>evaluate('!document.querySelector("dialog")'),'keys dialog closes');
  for(const width of [390,320]){await viewport(width);await fits(`AI tools at ${width}`);}
  await evaluate('document.querySelector("[aria-label=\'AI tools for this project\']").scrollIntoView()');await screenshot('ai-tools-mobile');
  await viewport(1440);
  await evaluate('Array.from(document.querySelectorAll("button")).find(b=>b.textContent.trim()==="Disconnect").click()');
  await eventually(()=>evaluate('!!document.querySelector("dialog")'),'disconnect confirmation');
  await evaluate('Array.from(document.querySelectorAll("dialog button")).find(b=>b.textContent.trim()==="Disconnect").click()');
  await eventually(()=>evaluate('!document.querySelector("dialog") && !document.body.innerText.includes("Northstar Slack")'),'disconnect removes source');
  await send("Emulation.setEmulatedMedia", {features:[{name:"prefers-color-scheme",value:"light"},{name:"prefers-reduced-motion",value:"reduce"}]});
  await delay(200);await screenshot("connections-light");
  assert.deepEqual(await evaluate("window.__chatFixture.unknown"),[]);
  await send("Emulation.setEmulatedMedia", {features:[{name:"prefers-color-scheme",value:"dark"}]});
  for(const [path,ready,name] of [["/login",'[role="status"]',"login"],["/s/locked-room",'input',"locked-room"],["/invite/expired",'[role="alert"]',"invitation"]]) {
    await send("Page.navigate",{url:base+path});
    await eventually(()=>evaluate(`!!document.querySelector(${JSON.stringify(ready)})`),name);
    for(const width of [1440,390,320]) {await viewport(width);await fits(`${name} at ${width}`);if(width!==320)await screenshot(`${name}-${width}`);}
    if(path==="/login") assert.equal(await evaluate('!!document.querySelector("input[type=password]")'),false,'no legacy password form');
    assert.deepEqual(await evaluate("window.__chatFixture.unknown"),[]);
  }
  await send("Page.navigate",{url:base+"/"});
  await eventually(()=>evaluate('!!document.querySelector("#download")'),"website");
  for(const width of [1440,768,390,320]) {
    await viewport(width);await fits(`website at ${width}`);
    assert.ok(await evaluate('Array.from(document.querySelectorAll("header a, header summary")).filter(el=>el.checkVisibility()).every(el=>{const r=el.getBoundingClientRect();return r.left>=0 && r.right<=innerWidth;})'),`website navigation reachable at ${width}`);
    if(width===1440 || width===390)await screenshot(`website-${width}`);
  }
  await click('summary[aria-label="Open navigation"]');
  assert.ok(await evaluate(`document.querySelector('nav[aria-label="Mobile navigation"]').checkVisibility()`));
  await escape();
  await click('button[aria-label^="Enlarge screenshot"]');
  await eventually(()=>evaluate('!!document.querySelector("dialog[open]")'),"screenshot preview");
  await escape();
  assert.equal(await evaluate('!!document.querySelector("dialog[open]")'),false);
  assert.deepEqual(errors,[]);
  console.log("PASS: website, sign-in, invitations, locked rooms, project overview, settings save, modal focus/scrolling, light/dark, reduced motion, project-scoped connections, channel search, explicit sharing, save failure/retry, disconnect, and responsive layouts.");
  console.log("Screenshots: "+join(tmpdir(),"multiplayer-ui-connections.png")+" and "+join(tmpdir(),"multiplayer-ui-connections-mobile.png"));
} finally {socket?.close();chrome.kill();if(server && server.exitCode===null){server.kill();await once(server,"exit").catch(()=>{});}}
