/** Auth form regression checks against a production build; API calls are browser fixtures. */
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {mkdtemp, readFile, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

const base=process.env.AUTH_UI_BASE_URL??'http://127.0.0.1:3118';
const token='a'.repeat(43),email='owner+beta@example.test';
const link=`${base}/login?invite=${token}&email=${encodeURIComponent(email)}`;
const directory=await mkdtemp(join(tmpdir(),'multiplayer-auth-ui-'));
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
let output='',socket,chrome;
const server=process.argv.includes('--start-server')?spawn(process.execPath,['node_modules/next/dist/bin/next','start','-H','127.0.0.1','-p',new URL(base).port],{env:{...process.env,SIGNUP_MODE:'invite'},stdio:['ignore','pipe','pipe']}):null;
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
      if(path==='/api/auth/continue'||path==='/api/auth/register'){
        const body=JSON.parse(init.body);window.__authRequests.push({path,...body});
        if(body.email==='existing@example.test')return json({status:'existing',user,connectCode:null});
        if(body.email!==${JSON.stringify(email)}||body.invitationToken!==${JSON.stringify(token)})return json({error:'Paste your invitation into the Invitation link or code field.',field:'invitation'},403);
        return path.endsWith('/continue')?json({status:'new'}):json({user,connectCode:null},201);
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
  assert.equal(await evaluate(`document.querySelector('input[placeholder="Paste your invitation link or code"]').value`),token,'URL credential visible in the invitation field');
  await fill('input[type=password]','test-browser-password');await submit();
  await eventually(()=>evaluate(`document.body.innerText.includes('Pick a username')`),'invitation signup');
  console.log('PASS: emailed invitation prefills the address and reaches username selection.');

  await send('Page.navigate',{url:base+'/login'});await ready();
  await fill('input[type=email]',email);await fill('input[type=password]','test-browser-password');await submit();
  await eventually(()=>evaluate(`!!document.querySelector('[role=alert]')`),'missing invitation feedback');
  await fill('input[placeholder="Paste your invitation link or code"]',link);await submit();
  await eventually(()=>evaluate(`document.body.innerText.includes('Pick a username')`),'recovery by pasting invitation');
  await fill('input[autocomplete=username]','fixture-owner');await submit();
  await eventually(()=>evaluate(`location.pathname==='/workspace'`),'registered workspace');
  const registration=await evaluate(`window.__authRequests.find(request=>request.path==='/api/auth/register')`);
  assert.equal(registration.invitationToken,token);assert.equal(registration.email,email);
  console.log('PASS: plain login recovers by pasting a full link and retains the token through registration.');

  await send('Page.navigate',{url:base+'/login'});await ready();
  await fill('input[type=email]','existing@example.test');await fill('input[type=password]','test-browser-password');await submit();
  await eventually(()=>evaluate(`location.pathname==='/workspace'`),'existing account login');
  assert.equal(await evaluate(`window.__authRequests[0].invitationToken`),undefined);
  console.log('PASS: existing accounts still sign in without an invitation.');
} finally {
  socket?.close();
  for(const child of [chrome,server])if(child&&child.exitCode===null){child.kill('SIGTERM');await Promise.race([once(child,'exit'),delay(3000)]);}
  await rm(directory,{recursive:true,force:true});
}
