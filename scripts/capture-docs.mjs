/** Captures actual UI components with in-browser sample data. No production account or API writes. */
import {mkdir} from 'node:fs/promises';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import sharp from 'sharp';
import assert from 'node:assert/strict';
import {docsBrowser,delay,eventually} from '../tests/helpers/docs-browser.mjs';
import {installFixtures as workspaceFixtures} from '../tests/helpers/workspace-browser-fixture.mjs';
import {installFixtures as teamFixtures} from '../tests/helpers/team-browser-fixture.mjs';

function sampleWorkspace(){
  const state=window.__model;
  const runId='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  state.repos=[{id:'frontendabcd',sessionId:state.room.id,rootName:'frontend',projectRepositoryId:'11111111-1111-4111-8111-111111111111',headSha:'a'.repeat(40),baseSha:'a'.repeat(40),seededAt:1,createdAt:1,createdBy:'alice'}];
  state.runs=[{id:runId,sessionId:state.room.id,repoId:'frontendabcd',startedBy:'alice',startedByName:'Alice',driverUserId:'alice',driverName:'Alice',controlVersion:0,agentId:'codex',title:'Plan the checkout flow',status:'completed',baseSha:'a'.repeat(40),createdAt:Date.now(),startedAt:Date.now()-60000,endedAt:Date.now(),archivedAt:null}];
  state.canGrant=true;
  // The terminal panel is shown working on the member's computer. Output is
  // scripted here rather than spawned, so captures stay deterministic and never
  // leak the capturing machine's user, host, or paths.
  const prompt='\x1b[38;5;180m~/northstar-checkout\x1b[0m \x1b[2m$\x1b[0m ';
  const session=[
    prompt+'git status --short\r\n',
    ' \x1b[33mM\x1b[0m checkout.ts\r\n',
    prompt+'npm test -- checkout\r\n',
    '\r\n\x1b[2m> northstar@1.0.0 test\x1b[0m\r\n\x1b[2m> vitest run checkout\x1b[0m\r\n\r\n',
    ' \x1b[32m✓\x1b[0m checkout.test.ts \x1b[2m(3 tests) 412ms\x1b[0m\r\n\r\n',
    ' \x1b[2mTest Files\x1b[0m  \x1b[32m1 passed\x1b[0m (1)\r\n',
    '      \x1b[2mTests\x1b[0m  \x1b[32m3 passed\x1b[0m (3)\r\n\r\n',
    prompt,
  ];
  // Captures are served from 127.0.0.1, where the terminal adds a local-only
  // "Open :port" link that people on multicode.in never see.
  document.addEventListener('DOMContentLoaded',()=>{const style=document.createElement('style');style.textContent='a[href^="http://localhost:"]{display:none!important}';document.head.append(style);});
  const frame=text=>btoa(String.fromCharCode(...new TextEncoder().encode(text)));
  const RealEventSource=window.EventSource;
  window.EventSource=function(url,config){
    if(!String(url).startsWith('/api/terminal/pty'))return new RealEventSource(url,config);
    const source={onmessage:null,onerror:null,addEventListener(){},removeEventListener(){},close(){}};
    session.forEach((chunk,index)=>setTimeout(()=>source.onmessage?.({data:frame(chunk)}),40+index*30));
    return source;
  };
  const original=window.fetch;
  window.fetch=async(input,init={})=>{
    const url=new URL(typeof input==='string'?input:input.url,location.origin),path=url.pathname;
    const json=body=>new Response(JSON.stringify(body),{headers:{'content-type':'application/json'}});
    if(path.endsWith('/access'))return json({invitationId:'sample-invite',email:'teammate@example.test',userId:'guest',canGrant:true,canRequest:true,requestPending:false,reason:null,scope:['Join organisation “Alice’s workspace” as a member.','Edit this project and workspace.','Handoff remains a separate action.'],scopeKey:'sample-scope',alreadyEditor:false,sessionId:state.room.id});
    if(path.endsWith('/tree'))return json({rootName:'frontend',root:{name:'frontend',path:'',type:'directory',children:[{name:'checkout.ts',path:'checkout.ts',type:'file',size:354},{name:'README.md',path:'README.md',type:'file',size:180}]},headSha:'a'.repeat(40),sessionBranch:'session/frontendabcd'});
    if(path.endsWith('/changes')&&url.searchParams.get('path'))return json({diff:['diff --git a/checkout.ts b/checkout.ts','--- a/checkout.ts','+++ b/checkout.ts','@@ -1,7 +1,11 @@',' export function validateQuantity(quantity: number) {','-  if (quantity < 1) {','-    return { valid: false, message: "Invalid quantity" };','+  if (!Number.isInteger(quantity) || quantity < 1) {','+    return { valid: false, message: "Choose at least one item." };','+  }','+  if (quantity > 99) {','+    return { valid: false, message: "You can order up to 99 at a time." };','   }',' ','   return { valid: true, message: "" };',' }',''].join('\n')});
    if(path.endsWith('/changes'))return json({head:'b'.repeat(40),totals:{files:3,added:33,removed:3},changes:[{path:'checkout.ts',status:'M',added:6,removed:2},{path:'checkout.test.ts',status:'A',added:24,removed:0},{path:'README.md',status:'M',added:3,removed:1}]});
    if(path.endsWith('/file')){const text='export function validateQuantity(quantity: number) {\n  if (!Number.isInteger(quantity) || quantity < 1) {\n    return { valid: false, message: "Choose at least one item." };\n  }\n\n  return { valid: true, message: "" };\n}\n';return json({text,size:text.length,truncated:false,binary:false});}
    if(path.endsWith('/runs/'+runId))return json({run:state.runs[0],messages:[
      {role:'user',body:'Help me plan a clearer checkout flow. Keep quantity errors close to the input and explain what to verify before we ship.'},
      {role:'tool',body:'Read checkout.ts'},
      {role:'tool',body:'Grep validateQuantity'},
      {role:'tool',body:'Edit checkout.ts'},
      {role:'assistant',body:'## A clearer checkout flow\n\nKeep the item summary and quantity controls together. Show a specific error beside the field that needs attention.\n\n### Next steps\n\n1. Validate quantity with `validateQuantity` before continuing.\n2. Keep keyboard focus on the field when it needs correction.\n3. Ask a teammate to check the empty-cart and error states.\n\nReview the saved code and run your checks before publishing.'},
    ]});
    if(path.endsWith('/handoff'))return json({run:state.runs[0],offers:[],recipients:[{id:'bob',name:'Bob'}]});
    if(path.endsWith('/reviews'))return json({reviews:[],hasMore:false,headSha:'a'.repeat(40),reviewers:[{id:'bob',name:'Bob'}],canRequest:true});
    if(path==='/api/tasks')return json({tasks:[],members:[{userId:'bob',handle:'bob',displayName:'Bob',role:'editor'}],hasMore:false});
    if(path==='/api/terminal')return json({enabled:true,location:'computer',device:'Alice’s Mac',cwd:'~/multicode-ai/workspaces/northstar-checkout',shell:'/bin/zsh',platform:'darwin'});
    if(path==='/api/terminal/pty')return json({ok:true});
    if(path.endsWith('/memories'))return json({memories:[{id:'memory-1',kind:'fact',text:'Show quantity errors next to the checkout input.',status:'approved',revision:1,stated_at:new Date().toISOString(),source_run_id:runId,publish_gated:false}],nextCursor:null});
    if(path.endsWith('/memories/memory-1'))return json({nodes:[{id:'memory-1',kind:'fact',text:'Show quantity errors next to the checkout input.',status:'approved',revision:1,stated_at:new Date().toISOString(),source_run_id:runId,publish_gated:false}],edges:[],events:[],jobs:[],sources:[{memory_id:'memory-1',body:'Keep the quantity validation close to the input so the problem is easy to fix.',author:'Alice'}]});
    if(path.endsWith('/briefing'))return json({body:{goal:'Improve the checkout flow and make errors easy to understand.',decisions:'Keep quantity validation next to the input. Source: approved room memory.',progress:'The AI outlined the flow. Code changes still need implementation and review.',blockers:'Check keyboard navigation and empty-cart behavior.',nextAction:'Implement the input validation, then request a teammate review.'},sources:[{kind:'message',id:'sample-message',label:'Conversation request',excerpt:'Help plan a clearer checkout flow.'}],fingerprint:'sample',sourceSeq:2,headSha:'a'.repeat(40),revision:0,sharedWithGuests:false,stale:false,canEdit:true,canPublish:true,updatedBy:null,updatedAt:null});
    return original(input,init);
  };
}

await mkdir('public/docs/images',{recursive:true});
const b=await docsBrowser();const {send,evaluate,navigate,button,click,type}=b;
let fixture;
async function install(source){if(fixture)await send('Page.removeScriptToEvaluateOnNewDocument',{identifier:fixture});fixture=(await send('Page.addScriptToEvaluateOnNewDocument',{source})).identifier;}
async function capture(name){
  await evaluate('document.fonts.ready');await delay(200);
  assert.ok(await evaluate('[...document.querySelectorAll("dialog[open] .ui-dialog-body")].every(el=>el.scrollWidth<=el.clientWidth+1)'),name+' dialog content must fit');
  const data=await send('Page.captureScreenshot',{format:'png'});
  await sharp(Buffer.from(data.data,'base64')).webp({lossless:true}).toFile(`public/docs/images/${name}.webp`);
  console.log('Captured '+name);
}
async function closeDialog(){
  for(let i=0;i<5;i++){
    const closed=await evaluate(`(()=>{const dialog=[...document.querySelectorAll('dialog[open]')].at(-1);const close=dialog?.querySelector('header button');if(close){close.click();return true;}return false;})()`);
    if(!closed){await send('Input.dispatchKeyEvent',{type:'keyDown',key:'Escape',code:'Escape',windowsVirtualKeyCode:27});await send('Input.dispatchKeyEvent',{type:'keyUp',key:'Escape',code:'Escape',windowsVirtualKeyCode:27});}
    await delay(150);if(!await evaluate('!!document.querySelector("dialog[open]")'))break;
  }
}
/** Open the terminal panel (it starts open) and wait for its scripted session. */
async function terminalSession(){
  if(!await evaluate(`!!document.querySelector('button[aria-label="Close terminal"]')`))await click('button[aria-label="Toggle terminal (Ctrl+Shift+Z)"]');
  await eventually(()=>evaluate('document.body.innerText.includes("3 passed")'),'terminal session');
  await delay(250);
}
try{
  // Authentication is rendered by Clerk. Capture it separately using a Clerk
  // development application; never mock email delivery or real credentials here.
  await install(`window.desktopSetup={status:async()=>({url:'https://multicode.in',builtIn:true,runner:'connected',enabled:true,paired:true,workspacesDir:'~/multicode-ai/workspaces',workspacesLocked:true,version:'preview',message:''})};`);
  await navigate(pathToFileURL(resolve('.desktop-build/app/setup.html')).href,'document.querySelector("#built-in-url")?.textContent==="multicode.in"');await capture('desktop-setup');
  await evaluate('document.querySelector("#worktrees-heading").scrollIntoView({block:"center"})');await capture('desktop-worktrees');
  await install(`(${teamFixtures.toString()})()`);
  await navigate('/workspace','document.body?.innerText.includes("Northstar Checkout")');await capture('workspace');
  await button('Invite to team');await capture('invite-team');await closeDialog();
  await button('Members');await eventually(()=>evaluate('document.body.innerText.includes("ADD FROM ORGANISATION")'),'project members');await capture('project-members');await closeDialog();
  await evaluate(`Array.from(document.querySelectorAll('button')).find(b=>b.textContent.includes('Connections')).click()`);
  await eventually(()=>evaluate('document.body.innerText.includes("Northstar Slack")'),'connections');await capture('connections');
  await install(`(${workspaceFixtures.toString()})();(${sampleWorkspace.toString()})();`);
  await navigate('/s/modelroomabc?run=aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','document.body?.innerText.includes("A clearer checkout flow")');
  await terminalSession();
  // Show the agent's tool steps rather than the collapsed summary.
  await evaluate(`[...document.querySelectorAll('button')].find(b=>/Thought & steps|Worked through \\d+ steps/.test(b.textContent))?.click()`);
  await eventually(()=>evaluate(`[...document.querySelectorAll('ol li')].some(li=>li.textContent.includes('checkout.ts'))`),'tool steps');
  await evaluate(`document.querySelector('.conversation-transcript')?.parentElement?.scrollTo(0,0)`);await delay(200);
  await capture('conversation');
  await click('button[aria-label="Choose model"]');await eventually(()=>evaluate('!!document.querySelector("[role=listbox]")'),'model menu');await capture('model-picker');await closeDialog();
  await click('button[aria-label="File: checkout.ts"]');await eventually(()=>evaluate('!!document.querySelector(".room-file-document textarea")'),'file viewer');await capture('files');
  // The Changes tab shows its file count ("Changes3"), so it is found by its start.
  await evaluate(`[...document.querySelectorAll('[aria-label="Explorer view"] [role=tab]')].find(b=>b.textContent.startsWith('Changes')).click()`);
  await eventually(()=>evaluate('document.body.innerText.includes("3 files changed")'),'saved changes');
  await click('ul[aria-label="Changed files"] button[aria-label$=": checkout.ts"]');await eventually(()=>evaluate('document.body.innerText.includes("You can order up to 99")'),'file diff');await capture('changes');await button('All files');await click('button[aria-label="Close checkout.ts"]');
  await click('button[aria-label="Add repository"]');await capture('add-repository');await click('button[aria-label="Start without files"]');await type('dialog input','Ideas and questions');await capture('empty-project');await closeDialog();
  await click('button[aria-label="Add repository"]');await button('Project repositories');await eventually(()=>evaluate('document.body.innerText.includes("backend")'),'project repositories');await capture('project-repositories');await closeDialog();
  // Set up AI with each state a tool can be in, then back to the room's single tool.
  await evaluate(`window.__model.extraAgents=[
    {id:'claude',name:'Claude Code',vendor:'Anthropic',blurb:'Reads and edits files, runs commands, works across the whole repo.',installed:true,auth:null,models:{choices:[{id:'',label:'Auto'}],source:'Sample',checkedAt:1,refreshedAt:1,stale:false},install:{command:'npm install -g @anthropic-ai/claude-code',signIn:'claude auth login',docs:'https://docs.claude.com'}},
    {id:'gemini',name:'Gemini CLI',vendor:'Google',blurb:'Large-context agent for reading and changing a codebase.',installed:true,auth:{loggedIn:false,method:null,email:null,plan:null},install:{command:'npm install -g @google/gemini-cli',signIn:'gemini',docs:'https://github.com/google-gemini/gemini-cli'}},
    {id:'opencode',name:'OpenCode',vendor:'Many providers',blurb:'Coding agents through configured providers.',installed:false,auth:null,install:{command:'npm install -g opencode-ai',signIn:'opencode auth login',docs:'https://opencode.ai/docs/providers/'}}]`);
  await button('Room guide');await button('Set up AI');await eventually(()=>evaluate('document.body.innerText.includes("2 of 4 AI tools ready")'),'provider setup');await capture('providers');await closeDialog();
  await evaluate('window.__model.extraAgents=undefined');
  await button('Room guide');await button('Connect your computer');await eventually(()=>evaluate('document.body.innerText.includes("Alice’s Mac")'),'computers');await capture('computers');await closeDialog();
  await button('Briefing');await eventually(()=>evaluate('document.querySelector("dialog")?.innerText.includes("Accepted decisions")'),'briefing');await capture('briefing');await closeDialog();
  await button('Activity');await eventually(()=>evaluate('document.body.innerText.includes("No uploaded checkpoints yet")'),'history');await capture('history');await closeDialog();
  await button('Room guide');await button('Review room memory');await eventually(()=>evaluate('document.querySelector("dialog")?.innerText.includes("Show quantity errors")'),'memory');
  await evaluate(`Array.from(document.querySelectorAll('dialog button')).find(b=>b.textContent.includes('Show quantity errors')).click()`);await eventually(()=>evaluate('document.querySelector("dialog")?.innerText.includes("Source evidence")'),'memory evidence');await capture('memory');await closeDialog();
  await button('Share chat');await eventually(()=>evaluate('!!document.querySelector("dialog input[type=email]")'),'share chat');await type('dialog input[type=email]','teammate@example.test');await capture('share-chat');await closeDialog();
  await evaluate(`window.__model.invitations=[{id:'sample-invite',email:'teammate@example.test',role:'commenter',createdAt:new Date().toISOString(),expiresAt:new Date(Date.now()+604800000).toISOString(),acceptedAt:new Date().toISOString(),revokedAt:null}]`);
  await button('Share chat');await button('Allow guest to help with code…');await eventually(()=>evaluate('document.querySelector("dialog")?.innerText.includes("Grant editing access")'),'guest access');await capture('guest-access');await closeDialog();
  await button('Handoff');await eventually(()=>evaluate('document.querySelector("dialog")?.innerText.includes("Offer handoff")'),'handoff');
  await capture('handoff');await closeDialog();
  await button('Assign Tasks');await capture('tasks');await closeDialog();
  // Teammate review and Feedback are under the chat nav's More.
  const fromMore=async label=>{await click('nav[aria-label="Chat"] button[aria-haspopup="menu"]');await eventually(()=>evaluate(`[...document.querySelectorAll('nav[aria-label="Chat"] [role=menuitem]')].some(b=>b.textContent.startsWith(${JSON.stringify(label)}))`),label+' in More');await evaluate(`[...document.querySelectorAll('nav[aria-label="Chat"] [role=menuitem]')].find(b=>b.textContent.startsWith(${JSON.stringify(label)})).click()`);};
  await fromMore('Teammate review');await eventually(()=>evaluate('document.querySelector("dialog")?.innerText.includes("Request teammate review")'),'review');await capture('reviews');await closeDialog();
  await fromMore('Feedback');await eventually(()=>evaluate('document.querySelector("dialog")?.innerText.includes("Please check delivery errors")'),'feedback');await capture('feedback');await closeDialog();
  await terminalSession();await capture('terminal');
  await evaluate(`window.__model.runs[0].status='running';window.__model.emit('run.started')`);
  await delay(500);await click('button[title^="Plan the checkout flow ·"]');
  // While the agent works the empty box offers Stop; typing turns it into Queue message.
  await eventually(()=>evaluate('!!document.querySelector(\'textarea[aria-label="Message working agent"]\')'),'running message queue');
  await type('textarea[aria-label="Message working agent"]','Also check the keyboard focus after a validation error.');await button('Queue message');
  await eventually(()=>evaluate('document.body.innerText.includes("Also check the keyboard focus")'),'queued instruction');await capture('queued-messages');
  if(b.errors.length)throw Error(b.errors.join('\n'));
}catch(error){console.error(await evaluate('document.body?.innerText').catch(()=>''));throw error;}finally{await b.close();}
