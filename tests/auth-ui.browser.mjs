/** Auth form regression checks against a production build; API calls are browser fixtures. */
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {mkdtemp, readFile, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

const openSignup=process.argv.includes('--open');
const base=process.env.AUTH_UI_BASE_URL??'http://127.0.0.1:3118';
const token='a'.repeat(43),email='owner+beta@example.test';
const link=`${base}/login?invite=${token}&email=${encodeURIComponent(email)}`;
const directory=await mkdtemp(join(tmpdir(),'multiplayer-auth-ui-'));
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
let output='',socket,chrome;
const server=process.argv.includes('--start-server')?spawn(process.execPath,['node_modules/next/dist/bin/next','start','-H','127.0.0.1','-p',new URL(base).port],{env:{...process.env,NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY:'',CLERK_SECRET_KEY:'',SIGNUP_MODE:openSignup?'open':'invite'},stdio:['ignore','pipe','pipe']}):null;
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
  const evaluate=async expression=>{const result=await send('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true});if(result.exceptionDetails)throw Error(result.exceptionDetails.exception?.description??result.exceptionDetails.text);return result.result.value;};
  await send('Page.enable');await send('Runtime.enable');
  await send('Emulation.setScriptExecutionDisabled',{value:true});
  await send('Page.navigate',{url:link});
  await eventually(()=>evaluate(`document.body.innerText.includes('Sign-in is being configured')`),'server-rendered setup state');
  assert.equal(await evaluate(`new URL(location.href).searchParams.get('invite')`),token,'invitation survives a slow or unavailable authentication script');
  assert.equal(await evaluate(`document.querySelector('input[type=password]')`),null,'retired password form is not exposed');
  await send('Emulation.setScriptExecutionDisabled',{value:false});
  for(const width of [1280,390,320]){
    await send('Emulation.setDeviceMetricsOverride',{width,height:844,deviceScaleFactor:1,mobile:width<500});
    assert.ok(await evaluate('document.documentElement.scrollWidth <= window.innerWidth'),'auth setup fits narrow windows');
  }
  console.log('PASS: unconfigured authentication has an accessible server-rendered state, preserves invitations, and never falls back to legacy credentials.');
  await send('Page.addScriptToEvaluateOnNewDocument',{source:`(()=>{
    const nativeFetch=window.fetch.bind(window);
    window.EventSource=class{addEventListener(){} removeEventListener(){} close(){}};
    window.fetch=(input,init={})=>{
      const path=new URL(typeof input==='string'?input:input.url,location.origin).pathname;
      if(path==='/api/auth/me')return Promise.resolve(Response.json({user:{id:'fixture-user',email:'existing@example.test',handle:'existing',displayName:'Existing',avatarUrl:null},connectCode:'PK-TEST-TEST'}));
      return nativeFetch(input,init);
    };
  })()`});
  await send('Emulation.setDeviceMetricsOverride',{width:1280,height:900,deviceScaleFactor:1,mobile:false});
  // A desktop browser has its own cookie jar. The selected project must survive
  // signing in there, including when it belongs to a user's second organisation.
  await send('Page.addScriptToEvaluateOnNewDocument',{source:`(()=>{
    if(!sessionStorage.getItem('connections-flow'))return;
    const originalFetch=window.fetch.bind(window);
    const json=(body,status=200)=>Promise.resolve(new Response(JSON.stringify(body),{status,headers:{'content-type':'application/json'}}));
    const orgs=['first-team','second-team'].map(slug=>({id:slug,slug,name:slug,myRole:'owner',createdAt:0,image:null}));
    const project={id:'second-project',orgId:'second-team',slug:'selected-project',name:'Selected project',myRole:'manager',createdAt:0,archivedAt:null};
    // Hold the provider response until the test releases it. Project selection
    // renders first in production too; it does not mean Connect Slack is ready.
    const integrationReady=new Promise(resolve=>{window.__releaseIntegrations=resolve;});
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
      if(path.endsWith('/integrations')){
        if(!sessionStorage.getItem('connections-authorized')){window.__integrationsLoading=true;await integrationReady;}
        return json({canManage:true,providers:[{id:'slack',configured:true},{id:'discord',configured:false}],connections:sessionStorage.getItem('connections-authorized')?[{id:'fixture-slack',provider:'slack',name:'Selected team Slack',channels:[]}]:[]});
      }
      if(path.endsWith('/integrations/slack')&&init.method==='POST'){
        sessionStorage.setItem('connections-authorized','1');sessionStorage.setItem('connections-authorized-path',path);
        return json({url:location.origin+'/workspace?org=second-team&connections=second-project&connected=slack'});
      }
      return originalFetch(input,init);
    };
  })()`});
  await evaluate(`sessionStorage.setItem('connections-flow','desktop');sessionStorage.setItem('connections-signed-in','1')`);
  await send('Page.navigate',{url:base+'/workspace?org=second-team&connections=second-project'});
  const selectedProject=()=>evaluate(`document.querySelector('button[aria-label="Project for connections"]')?.textContent.trim()==='Selected project'`);
  const connectionsReady=async()=>{
    await eventually(()=>evaluate('window.__integrationsLoading===true'),'provider request started');
    assert.equal(await evaluate(`Array.from(document.querySelectorAll('button')).some(b=>b.textContent.trim()==='Connect Slack')`),false,'project selection is available before providers load');
    await evaluate('window.__releaseIntegrations()');
    await eventually(()=>evaluate(`Array.from(document.querySelectorAll('button')).some(b=>b.textContent.trim()==='Connect Slack'&&!b.disabled&&b.checkVisibility())`),'Connect Slack ready');
  };
  await eventually(selectedProject,'selected desktop project');
  await connectionsReady();
  await evaluate(`Array.from(document.querySelectorAll('button')).find(b=>b.textContent.trim()==='Connect Slack').click()`);
  await eventually(()=>evaluate(`!!window.__openedConnection`),'browser handoff');
  const browserUrl=await evaluate('window.__openedConnection');
  assert.equal(new URL(browserUrl).searchParams.get('org'),'second-team');
  assert.equal(new URL(browserUrl).searchParams.get('connections'),'second-project');
  assert.ok(await evaluate(`document.body.innerText.includes('Continue in your browser')`));
  await evaluate(`sessionStorage.setItem('connections-flow','browser');sessionStorage.removeItem('connections-signed-in')`);
  await send('Page.navigate',{url:browserUrl});await eventually(()=>evaluate(`location.pathname==='/login'`),'browser sign-in destination');
  assert.equal(await evaluate(`new URL(location.href).searchParams.get('next')`),new URL(browserUrl).pathname+new URL(browserUrl).search);
  // Clerk owns credential entry; simulate its completed sign-in for this application navigation regression.
  const destination=await evaluate(`new URL(location.href).searchParams.get('next')`);
  await evaluate(`sessionStorage.setItem('connections-signed-in','1')`);
  await send('Page.navigate',{url:base+destination});
  await eventually(selectedProject,'selected project restored after browser sign-in');
  await connectionsReady();
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
