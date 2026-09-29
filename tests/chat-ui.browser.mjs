/** Browser checks of the real workspace UI with isolated, in-browser API fixtures.
 * Start a built app first. No fixture request reaches the app's database.
 * CHAT_UI_BASE_URL=http://localhost:3100 node tests/chat-ui.browser.mjs
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";

const base = process.env.CHAT_UI_BASE_URL ?? "http://localhost:3100";
const directory = await mkdtemp(join(tmpdir(), "multiplayer-chat-ui-"));
const chrome = spawn(process.env.CHROME_BIN ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", [
  "--headless=new", "--disable-gpu", "--no-first-run", "--no-default-browser-check",
  "--remote-debugging-port=9336", `--user-data-dir=${directory}`, "about:blank",
], { stdio: "ignore" });
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function eventually(task, label) {
  for (let i = 0; i < 100; i++) { if (await task()) return; await delay(100); }
  throw new Error(`Timed out: ${label}`);
}

function installFixtures() {
  const members = [
    { userId: "alex", handle: "alex", displayName: "Alex Chen", avatarUrl: null, role: "owner" },
    { userId: "priya", handle: "priya", displayName: "Priya Shah", avatarUrl: null, role: "member" },
    { userId: "sam", handle: "sam", displayName: "Sam Rivera", avatarUrl: null, role: "member" },
    { userId: "jordan", handle: "jordan", displayName: "Jordan Lee", avatarUrl: null, role: "member" },
    { userId: "maya", handle: "maya", displayName: "Maya Patel", avatarUrl: null, role: "member" },
  ];
  const org = { id: "northstar", slug: "northstar", name: "Northstar Studio", image: "", myRole: "owner", createdAt: 0 };
  const channels = ["general", "product-design", "engineering", "shipping", "ideas-and-feedback"].map((name, index) => ({ id: name, name, kind: "channel", visibility: "public", unread: index === 2 ? 3 : 0, lastMessageAt: null, lastPreview: null, otherUserId: null }));
  const dms = members.slice(1, 4).map(member => ({ id: `dm-${member.userId}`, name: member.displayName, kind: "dm", visibility: "private", unread: 0, lastMessageAt: null, lastPreview: null, otherUserId: member.userId }));
  const message = (id, userId, body, at) => {
    const user = members.find(member => member.userId === userId);
    return { id, userId, userName: user.displayName, handle: user.handle, body, createdAt: new Date(at).getTime() };
  };
  const messages = [
    message("m1", "priya", "The new checkout flow is ready for a look. I’ve kept the empty-cart state simple and added a clearer order summary.", "2026-09-28T10:30:00"),
    message("m2", "priya", "You can find the changes in my project room whenever you have a minute.", "2026-09-28T10:31:00"),
    message("m3", "sam", "Just went through it. The spacing feels much better — especially on the smaller screen.", "2026-09-28T10:38:00"),
    message("m4", "alex", "Let’s use this channel to keep the design and engineering decisions together. Small updates are welcome, too.", "2026-09-29T09:10:00"),
    message("m5", "jordan", "One thought: can we keep the quantity validation close to the input? It will make the error easier to fix.", "2026-09-29T09:16:00"),
    message("m6", "priya", "@alex the validation changes are in. I’ve also left the full context in the AI chat so you can pick up the review.", "2026-09-29T09:22:00"),
    message("m7", "maya", "Nice. I’ll check the keyboard flow and focus states this afternoon.", "2026-09-29T09:25:00"),
    message("m8", "alex", "Sounds good. Let’s review the changes together before we publish. Thanks, everyone!", "2026-09-29T09:28:00"),
  ];
  window.__chatFixture = { failNext: false, sent: [], unknown: [], messages, streams: [], sendDelay: 0 };
  class FixtureEventSource extends EventTarget {
    constructor(url) {
      super(); this.url = url;
      window.__chatFixture.streams.push(this);
      setTimeout(() => { this.onopen?.(new Event("open")); this.dispatchEvent(new MessageEvent("ready", {data: "{}"})); }, 30);
    }
    close() { window.__chatFixture.streams = window.__chatFixture.streams.filter(item => item !== this); }
  }
  window.EventSource = FixtureEventSource;
  const nativeFetch = window.fetch.bind(window);
  window.fetch = async (input, init = {}) => {
    const url = new URL(typeof input === "string" ? input : input.url, location.origin);
    if (!url.pathname.startsWith("/api/")) return nativeFetch(input, init);
    const path = url.pathname;
    const json = (body, status = 200) => Promise.resolve(new Response(JSON.stringify(body), { status, headers: {"content-type":"application/json"} }));
    if (path === "/api/orgs") return json({ orgs: [org, {...org, id:"labs", slug:"labs", name:"Side Projects", myRole:"member"}] });
    if (path === "/api/auth/me") return json({user:{id:"alex",handle:"alex",displayName:"Alex Chen",email:"alex@example.test",avatarUrl:null},connectCode:null});
    if (path === "/api/invitations") return json({invitations:[]});
    if (path.endsWith("/usage")) return json({concurrency:{used:0,limit:3},monthly:{used:0,limit:null}});
    if (path.endsWith("/projects")) return json({projects:[{id:"checkout",orgId:org.id,slug:"checkout",name:"Northstar Checkout",source:"local",githubRepo:null,defaultBranch:"main",upstreamUrl:null,myRole:"manager",createdAt:0,archivedAt:null}]});
    if (path.endsWith("/rooms")) return json({sessions:[{id:"alex-room",name:"Checkout · Alex",ownerId:"alex",visibility:"public"},{id:"priya-room",name:"Checkout · Priya",ownerId:"priya",visibility:"public"}]});
    if (path === "/api/tasks") return json({tasks:[],members:[],hasMore:false});
    if (path === "/api/chat/conversations") return json({conversations:[...channels,...dms]});
    if (path.endsWith("/read")) return json({ok:true});
    if (path.endsWith("/messages")) {
      const conversationId = path.split("/")[4];
      if (init.method === "POST") {
        if (window.__chatFixture.failNext) {window.__chatFixture.failNext = false; return json({error:"Could not send. Try again."},503);}
        if (window.__chatFixture.sendDelay) await new Promise(resolve=>setTimeout(resolve,window.__chatFixture.sendDelay));
        const body = JSON.parse(init.body).body;
        const saved = message(`sent-${window.__chatFixture.sent.length}`,"alex",body,new Date().toISOString());
        window.__chatFixture.sent.push(saved);messages.push(saved);
        for (const stream of window.__chatFixture.streams) stream.dispatchEvent(new MessageEvent("chat.message", {data:JSON.stringify({type:"chat.message",conversationId,message:saved})}));
        return json(saved,201);
      }
      if (url.searchParams.has("before")) return json({messages:[message("earlier","sam","Earlier context: keep the first release focused on the checkout experience.","2026-09-27T09:00:00")],hasMore:false});
      return json({messages:conversationId.startsWith("dm-") ? [] : messages,hasMore:!conversationId.startsWith("dm-")});
    }
    if (path.startsWith("/api/chat/conversations/")) {
      const item=[...channels,...dms].find(item=>item.id===path.split("/")[4]);
      return json({conversation:{...item,orgId:org.id,topic:item.kind==="channel" ? "A shared space for thoughtful product decisions." : null,members:item.kind==="dm" ? members.filter(member=>member.userId==="alex" || member.userId===item.otherUserId) : members,myRole:"owner"}});
    }
    window.__chatFixture.unknown.push(path);
    return json({error:`Unmocked fixture: ${path}`},404);
  };
}

let socket;
try {
  let targets;
  await eventually(async()=>{try {targets=await (await fetch("http://127.0.0.1:9336/json")).json();return targets.length;}catch{return false;}},"browser");
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
  const click=async selector=>{assert.ok(await evaluate(`!!document.querySelector(${JSON.stringify(selector)})`),selector);await evaluate(`document.querySelector(${JSON.stringify(selector)}).click()`);await delay(80);};
  const type=async(selector,value)=>{await evaluate(`(()=>{const el=document.querySelector(${JSON.stringify(selector)});Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el),'value').set.call(el,${JSON.stringify(value)});el.dispatchEvent(new Event('input',{bubbles:true}));})()`);await delay(80);};
  await send("Page.enable");await send("Runtime.enable");
  await send("Page.addScriptToEvaluateOnNewDocument",{source:`(${installFixtures.toString()})()`});
  await send("Emulation.setDeviceMetricsOverride",{width:1440,height:900,deviceScaleFactor:1,mobile:false});
  await send("Page.navigate",{url:base+"/workspace"});
  await eventually(()=>evaluate('Array.from(document.querySelectorAll("button")).some(b=>b.textContent.trim()==="#product-design")'),"channels");
  await evaluate('Array.from(document.querySelectorAll("button")).find(b=>b.textContent.trim()==="#product-design").click()');
  await eventually(()=>evaluate('!!document.querySelector("textarea") && document.body.innerText.includes("Thanks, everyone!")'),"conversation");
  await evaluate("document.fonts.ready");await delay(200);
  assert.ok(await evaluate('document.querySelector("#conversation-members").innerText.includes("Priya Shah")'));
  await writeFile(process.env.CHAT_UI_SCREENSHOT ?? join(tmpdir(),"multiplayer-team-chat.png"),Buffer.from((await send("Page.captureScreenshot")).data,"base64"));
  await click('button[aria-label="Search messages"]');
  await type('input[aria-label="Search loaded messages"]',"quantity validation");
  assert.equal(await evaluate('document.querySelectorAll("article").length'),1);
  await type('input[aria-label="Search loaded messages"]',"no-such-message");
  assert.ok(await evaluate('document.body.innerText.includes("No loaded messages match")'));
  await click('button[aria-label="Close message search"]');
  await type("textarea","A message to retry");
  await evaluate("window.__chatFixture.failNext=true");
  await click('button[aria-label="Send message"]');
  await eventually(()=>evaluate('!!document.querySelector("[role=alert]")'),"send failure");
  assert.equal(await evaluate('document.querySelector("textarea").value'),"A message to retry");
  assert.ok(await evaluate('document.body.innerText.includes("Thanks, everyone!")'));
  await click('button[aria-label="Send message"]');
  await eventually(()=>evaluate('document.querySelector("textarea").value === ""'),"successful retry");
  assert.equal(await evaluate('Array.from(document.querySelectorAll("article p")).filter(p=>p.textContent==="A message to retry").length'),1);
  await type("textarea","Only send once");
  await evaluate("window.__chatFixture.sendDelay=250");
  await evaluate('const send=document.querySelector("button[aria-label=\\"Send message\\"]");send.click();send.click()');
  await eventually(()=>evaluate('document.querySelector("textarea").value === ""'),"single send");
  assert.equal(await evaluate('window.__chatFixture.sent.filter(m=>m.body==="Only send once").length'),1);
  assert.equal(await evaluate('document.querySelector("textarea").maxLength'),4000);
  await type("textarea","A composed message");
  const sentBefore = await evaluate('window.__chatFixture.sent.length');
  await evaluate('document.querySelector("textarea").dispatchEvent(new KeyboardEvent("keydown",{key:"Enter",isComposing:true,bubbles:true,cancelable:true}))');
  await evaluate('document.querySelector("textarea").dispatchEvent(new KeyboardEvent("keydown",{key:"Enter",shiftKey:true,bubbles:true,cancelable:true}))');
  assert.equal(await evaluate('window.__chatFixture.sent.length'),sentBefore);
  assert.equal(await evaluate('document.querySelector("textarea").value'),"A composed message");
  await type("textarea","");
  await evaluate('Array.from(document.querySelectorAll("button")).find(b=>b.textContent==="Load earlier messages").click()');
  await eventually(()=>evaluate('document.body.innerText.includes("Earlier context:")'),"history pagination");
  for(const width of [768,390,320]){
    await send("Emulation.setDeviceMetricsOverride",{width,height:900,deviceScaleFactor:1,mobile:width<500});await delay(100);
    assert.equal(await evaluate("document.documentElement.scrollWidth <= innerWidth"),true,`overflow at ${width}`);
    assert.equal(await evaluate('!!document.querySelector("#conversation-members")'),false);
    await click('button[aria-label="Toggle member list"]');
    assert.ok(await evaluate('!!document.querySelector("#conversation-members")'));
    await click('button[aria-label="Close member list"]');
    const composer=await evaluate('(()=>{const r=document.querySelector("textarea").getBoundingClientRect();return {right:r.right,bottom:r.bottom,width:r.width}})()');
    assert.ok(composer.right<=width && composer.bottom<=900 && composer.width>80,`composer at ${width}`);
    if(width===390)await writeFile(join(tmpdir(),"multiplayer-team-chat-mobile.png"),Buffer.from((await send("Page.captureScreenshot")).data,"base64"));
  }
  await send("Emulation.setDeviceMetricsOverride",{width:1440,height:900,deviceScaleFactor:1,mobile:false});await delay(100);
  await evaluate('Array.from(document.querySelectorAll("button")).find(b=>b.textContent.trim()==="PSPriya Shah").click()');
  await eventually(()=>evaluate('document.body.innerText.includes("This is the start of your conversation with Priya Shah.")'),"direct messages");
  assert.deepEqual(await evaluate("window.__chatFixture.unknown"),[]);
  assert.deepEqual(errors,[]);
  console.log("PASS: real chat UI, members, search, empty results, send failure/draft recovery, SSE deduplication, double-send prevention, history, DMs, and responsive layouts.");
  console.log("Screenshots: "+(process.env.CHAT_UI_SCREENSHOT ?? join(tmpdir(),"multiplayer-team-chat.png"))+" and "+join(tmpdir(),"multiplayer-team-chat-mobile.png"));
} finally {socket?.close();chrome.kill();}
