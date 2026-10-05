/** Auth form regression checks against a production build; API calls are browser fixtures. */
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

const openSignup=process.argv.includes('--open');
const base=process.env.AUTH_UI_BASE_URL??'http://127.0.0.1:3118';
const token='a'.repeat(43),email='owner+beta@example.test';
const link=`${base}/login?invite=${token}&email=${encodeURIComponent(email)}`;
const directory=await mkdtemp(join(tmpdir(),'multiplayer-auth-ui-'));
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
let output='',socket,chrome;
const server=process.argv.includes('--start-server')?spawn(process.execPath,['node_modules/next/dist/bin/next','start','-H','127.0.0.1','-p',new URL(base).port],{env:{...process.env,SIGNUP_MODE:openSignup?'open':'invite'},stdio:['ignore','pipe','pipe']}):null;
for(const stream of [server?.stdout,server?.stderr])stream?.on('data',chunk=>{output=(output+chunk).slice(-4000);});
async function eventually(task,label){for(let i=0;i<120;i++){if(server?.exitCode!=null)throw Error(output);try{if(await task())return;}catch{}await delay(100);}throw Error('Timed out: '+label);}
try {
  await eventually(async()=>{try{return(await fetch(base+'/login')).ok;}catch{return false;}},'login server');
  chrome=spawn(process.env.CHROME_BIN??'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',['--headless=new','--disable-gpu','--no-first-run','--no-default-browser-check','--remote-debugging-port=0',`--user-data-dir=${directory}`,'about:blank'],{stdio:'ignore'});
  let port;await eventually(async()=>{port=(await readFile(join(directory,'DevToolsActivePort'),'utf8')).split('\n')[0];return !!port;},'browser');
  const targets=await(await fetch('http://127.0.0.1:'+port+'/json')).json();
  socket=new WebSocket(targets.find(target=>target.type==='page').webSocketDebuggerUrl);await once(socket,'open');
  let sequence=0;const pending=new Map();
  socket.onmessage=event=>{const message=JSON.parse(event.data),operation=pending.get(message.id);if(operation){pending.delete(message.id);clearTimeout(operation.timer);if(message.error)operation.reject(Error(message.error.message));else operation.resolve(message.result);}};
  const send=(method,params={})=>new Promise((resolve,reject)=>{const id=++sequence,timer=setTimeout(()=>{pending.delete(id);reject(Error('CDP timeout: '+method));},15000);pending.set(id,{resolve,reject,timer});socket.send(JSON.stringify({id,method,params}));});
  const evaluate=async expression=>{const result=await send('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true});if(result.exceptionDetails)throw Error(result.exceptionDetails.text);return result.result.value;};
  const fill=async(selector,value)=>{await evaluate(`(()=>{const el=document.querySelector(${JSON.stringify(selector)});Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(el,${JSON.stringify(value)});el.dispatchEvent(new Event('input',{bubbles:true}));})()`);await delay(100);};
  const ready=()=>eventually(()=>evaluate(`!!document.querySelector('button[type=submit]')&&!document.querySelector('button[type=submit]').disabled`),'interactive form');
  const submit=()=>evaluate(`document.querySelector('button[type=submit]').click()`);
  await send('Page.enable');await send('Runtime.enable');
  await send('Emulation.setScriptExecutionDisabled',{value:true});
  await send('Page.navigate',{url:link});
  await eventually(()=>evaluate(`!!document.querySelector('button[type=submit]')`),'server-rendered form');
  assert.equal(await evaluate(`document.querySelector('button[type=submit]').disabled`),true,'submission disabled before hydration');
  await submit();
  assert.equal(await evaluate(`new URL(location.href).searchParams.get('invite')`),token,'early submit cannot strip the invitation');
  console.log('PASS: a slow script load cannot submit the form and lose its invitation.');
  await send('Emulation.setScriptExecutionDisabled',{value:false});
  await send('Page.addScriptToEvaluateOnNewDocument',{source:`(()=>{
    const nativeFetch=window.fetch.bind(window);window.__authRequests=[];
    const json=(body,status=200)=>Promise.resolve(new Response(JSON.stringify(body),{status,headers:{'content-type':'application/json'}}));
    const user={id:'fixture-user',email:'existing@example.test',handle:'existing',displayName:'Existing',avatarUrl:null};
    window.EventSource=class{addEventListener(){} removeEventListener(){} close(){}};
    window.fetch=(input,init={})=>{const path=new URL(typeof input==='string'?input:input.url,location.origin).pathname;if(!path.startsWith('/api/'))return nativeFetch(input,init);
      if(path==='/api/auth/login'||path==='/api/auth/register'){
        const body=JSON.parse(init.body);window.__authRequests.push({path,...body});
        if(path==='/api/auth/login')return body.identifier==='existing@example.test'?json({status:'authenticated',user,connectCode:null}):json({error:'That email and password do not match.'},401);
        if(!${openSignup}&&(body.email!==${JSON.stringify(email)}||body.invitationToken!==${JSON.stringify(token)}))return json({error:'Paste your invitation into the Invitation link or code field.',field:'invitation'},403);
        return json({status:'authenticated',user,connectCode:null},201);
      }
      if(path==='/api/auth/me')return json({user,connectCode:null});
      if(path==='/api/orgs')return json({orgs:[]});
      if(path==='/api/invitations')return json({invitations:[]});
      if(path==='/api/tasks')return json({tasks:[],members:[],hasMore:false});
      return json({});
    };
  })()`});
  await send('Page.reload',{ignoreCache:true});await ready();
  assert.equal(await evaluate(`document.querySelector('input[type=email]').value`),email,'invited email prefilled');
  if(!openSignup)assert.equal(await evaluate(`document.querySelector('input[placeholder="Paste your invitation link or code"]').value`),token,'URL credential visible');
  assert.equal(await evaluate(`document.querySelector('input[autocomplete=username]')`),null,'no username step');
  await fill('input[type=password]','test-browser-password');await submit();
  await eventually(()=>evaluate(`location.pathname==='/workspace'`),'one-step signup');
  assert.equal(await evaluate(`window.__authRequests.length`),1,'one signup request');
  console.log('PASS: emailed invitation prefills the address and creates the account in one step.');

  await send('Page.navigate',{url:base+'/login?mode=signup'});await ready();
  await send('Emulation.setDeviceMetricsOverride',{width:390,height:844,deviceScaleFactor:1,mobile:true});
  assert.equal(await evaluate(`document.querySelector('input[autocomplete=new-password]')!==null`),true);
  assert.ok(await evaluate('document.documentElement.scrollWidth <= window.innerWidth'),'mobile signup fits');
  await writeFile('/tmp/multiplayer-email-signup-'+(openSignup?'open':'invite')+'.png',Buffer.from((await send('Page.captureScreenshot')).data,'base64'));
  await fill('input[type=email]',email);await fill('input[type=password]','test-browser-password');await submit();
  if(!openSignup){
    await eventually(()=>evaluate(`!!document.querySelector('[role=alert]')`),'missing invitation feedback');
    await fill('input[placeholder="Paste your invitation link or code"]',link);await submit();
  }
  await eventually(()=>evaluate(`location.pathname==='/workspace'`),'registered workspace');
  const registration=await evaluate(`window.__authRequests.filter(request=>request.path==='/api/auth/register').at(-1)`);
  assert.equal(registration.invitationToken,openSignup?undefined:token);assert.equal(registration.email,email);
  assert.equal(registration.handle,undefined,'username is generated on the server');
  console.log('PASS: email signup needs no username and respects configured admission mode.');
  await send('Emulation.setDeviceMetricsOverride',{width:1280,height:900,deviceScaleFactor:1,mobile:false});

  await send('Page.navigate',{url:base+'/login'});await ready();
  assert.equal(await evaluate(`document.querySelector('input[placeholder="Paste your invitation link or code"]')`),null,'login never asks for an invitation');
  await fill('input[type=email]','existing@example.test');await fill('input[type=password]','test-browser-password');await submit();
  await eventually(()=>evaluate(`location.pathname==='/workspace'`),'existing account login');
  assert.equal(await evaluate(`window.__authRequests[0].invitationToken`),undefined);
  console.log('PASS: existing accounts still sign in without an invitation.');

  // A desktop browser has its own cookie jar. The selected project must survive
  // signing in there, including when it belongs to a user's second organisation.
  await send('Page.addScriptToEvaluateOnNewDocument',{source:`(()=>{
    if(!sessionStorage.getItem('connections-flow'))return;
    const originalFetch=window.fetch.bind(window);
    const json=(body,status=200)=>Promise.resolve(new Response(JSON.stringify(body),{status,headers:{'content-type':'application/json'}}));
    const orgs=['first-team','second-team'].map(slug=>({id:slug,slug,name:slug,myRole:'owner',createdAt:0,image:null}));
    const project={id:'second-project',orgId:'second-team',slug:'selected-project',name:'Selected project',myRole:'manager',createdAt:0,archivedAt:null};
    if(sessionStorage.getItem('connections-flow')==='desktop'){
      window.desktop={isDesktop:true};window.open=url=>{window.__openedConnection=url;return null;};
    }
    window.fetch=async(input,init={})=>{
      const path=new URL(typeof input==='string'?input:input.url,location.origin).pathname;
      if(path==='/api/auth/login'){
        const response=await originalFetch(input,init);
        if(response.ok)sessionStorage.setItem('connections-signed-in','1');return response;
      }
      if(path==='/api/orgs')return sessionStorage.getItem('connections-signed-in')?json({orgs}):json({error:'Sign in required'},401);
      if(path.endsWith('/projects'))return json({projects:path.includes('/second-team/')?[project]:[]});
      if(path.endsWith('/rooms'))return json({sessions:[]});
      if(path.endsWith('/usage'))return json({concurrency:{used:0,limit:3},monthly:{used:0,limit:null}});
      if(path.endsWith('/integrations'))return json({canManage:true,providers:[{id:'slack',configured:true},{id:'discord',configured:false}],connections:sessionStorage.getItem('connections-authorized')?[{id:'fixture-slack',provider:'slack',name:'Selected team Slack',channels:[]}]:[]});
      if(path.endsWith('/integrations/slack')&&init.method==='POST'){
        sessionStorage.setItem('connections-authorized','1');sessionStorage.setItem('connections-authorized-path',path);
        return json({url:location.origin+'/workspace?org=second-team&connections=second-project&connected=slack'});
      }
      return originalFetch(input,init);
    };
  })()`});
  await evaluate(`sessionStorage.setItem('connections-flow','desktop');sessionStorage.setItem('connections-signed-in','1')`);
  await send('Page.navigate',{url:base+'/workspace?org=second-team&connections=second-project'});
  const selectedProject=()=>evaluate(`document.querySelector('select[aria-label="Project for connections"]')?.value==='second-project'`);
  await eventually(selectedProject,'selected desktop project');
  await evaluate(`Array.from(document.querySelectorAll('button')).find(b=>b.textContent.trim()==='Connect Slack').click()`);
  await eventually(()=>evaluate(`!!window.__openedConnection`),'browser handoff');
  const browserUrl=await evaluate('window.__openedConnection');
  assert.equal(new URL(browserUrl).searchParams.get('org'),'second-team');
  assert.equal(new URL(browserUrl).searchParams.get('connections'),'second-project');
  assert.ok(await evaluate(`document.body.innerText.includes('Continue in your browser')`));
  await evaluate(`sessionStorage.setItem('connections-flow','browser');sessionStorage.removeItem('connections-signed-in')`);
  await send('Page.navigate',{url:browserUrl});await ready();
  assert.equal(await evaluate(`new URL(location.href).searchParams.get('next')`),new URL(browserUrl).pathname+new URL(browserUrl).search);
  await fill('input[type=email]','existing@example.test');await fill('input[type=password]','test-browser-password');await submit();
  await eventually(selectedProject,'selected project restored after browser sign-in');
  await evaluate(`Array.from(document.querySelectorAll('button')).find(b=>b.textContent.trim()==='Connect Slack').click()`);
  await eventually(()=>evaluate(`document.body.innerText.includes('Selected team Slack')&&Array.from(document.querySelectorAll('button')).some(b=>b.textContent.trim()==='Choose channels')`),'provider callback returns to channel selection');
  assert.equal(await evaluate(`sessionStorage.getItem('connections-authorized-path')`),'/api/orgs/second-team/projects/selected-project/integrations/slack');
  console.log('PASS: desktop handoff retains organisation/project through browser login, authorization and channel selection.');
} finally {
  if(socket?.readyState===WebSocket.OPEN)socket.send(JSON.stringify({id:0,method:'Browser.close'}));
  socket?.close();
  for(const child of [chrome,server])if(child&&child.exitCode===null){child.kill('SIGTERM');await Promise.race([once(child,'exit'),delay(3000)]);}
  await rm(directory,{recursive:true,force:true,maxRetries:10,retryDelay:100});
}
