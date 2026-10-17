import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {mkdtemp,readFile,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';

export async function sharedChatBrowser({base,runId,token,guestToken,hostToken,revoke,shareByLink}) {
  const directory=await mkdtemp(join(tmpdir(),'shared-chat-browser-'));
  const chrome=spawn(process.env.CHROME_BIN??'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',[
    '--headless=new','--disable-gpu','--no-first-run','--no-default-browser-check','--remote-debugging-port=0',`--user-data-dir=${directory}`,'about:blank',
  ],{stdio:'ignore'});
  let socket;
  const eventually=async(task,label)=>{for(let i=0;i<180;i++){if(await task())return;await delay(100);}throw Error('Timed out: '+label);};
  try{
    let port;
    await eventually(async()=>{try{port=(await readFile(join(directory,'DevToolsActivePort'),'utf8')).split('\n')[0];return !!port;}catch{return false;}},'Chrome');
    const targets=await(await fetch(`http://127.0.0.1:${port}/json`)).json();
    socket=new WebSocket(targets.find(t=>t.type==='page').webSocketDebuggerUrl);await once(socket,'open');
    const pending=new Map();let sequence=0;const errors=[];
    socket.onmessage=event=>{const message=JSON.parse(event.data);if(message.method==='Runtime.exceptionThrown')errors.push(message.params.exceptionDetails.text);const item=pending.get(message.id);if(item){pending.delete(message.id);clearTimeout(item.timer);if(message.error)item.reject(Error(message.error.message));else item.resolve(message.result);}};
    const send=(method,params={})=>new Promise((resolve,reject)=>{const id=++sequence,timer=setTimeout(()=>reject(Error('CDP timeout: '+method)),15000);pending.set(id,{resolve,reject,timer});socket.send(JSON.stringify({id,method,params}));});
    const evaluate=async expression=>{const r=await send('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true});if(r.exceptionDetails)throw Error(r.exceptionDetails.text);return r.result.value;};
    await send('Page.enable');await send('Runtime.enable');await send('Network.enable');
    if(hostToken){
      await send('Network.setCookie',{name:'__client_uat',value:'1',url:base});
      await send('Network.setCookie',{name:'__clerk_db_jwt',value:'fixture',url:base});
      await send('Network.setCookie',{name:'__session',value:hostToken,url:base,httpOnly:true,sameSite:'Lax'});
      await send('Page.navigate',{url:`${base}/shared/${runId}`});
      await eventually(()=>evaluate('Array.from(document.querySelectorAll("button")).some(b=>b.textContent==="Edit briefing")'),'host briefing');
      await evaluate('Array.from(document.querySelectorAll("button")).find(b=>b.textContent==="Edit briefing").click()');
      await eventually(()=>evaluate(`!!document.getElementById('briefing-${runId}-nextAction')`),'editable briefing');
      await evaluate(`(()=>{const el=document.getElementById('briefing-${runId}-nextAction');Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(el,'Check delivery failures before accepting the implementation.');el.dispatchEvent(new Event('input',{bubbles:true}));})()`);
      await evaluate('document.querySelector("input[type=checkbox]").click()');await delay(100);
      await evaluate('Array.from(document.querySelectorAll("button")).find(b=>b.textContent==="Save briefing").click()');
      await eventually(()=>evaluate('document.body.innerText.includes("Briefing saved.")'),'briefing persisted');
      await send('Network.deleteCookies',{name:'__session',url:base});
    }
    // People added by email open the chat's own address; older invitations carry a token.
    await send('Page.navigate',{url:`${base}/shared/${runId}${token?`#invite=${token}`:''}`});
    await eventually(()=>evaluate('!!document.body?.innerText.includes("You’re invited to a conversation")'),'signed-out invitation');
    if(token)assert.equal(await evaluate(`sessionStorage.getItem('shared-chat-invite:${runId}')`),token);
    await evaluate(`document.querySelector('a[href^="/login?mode=signup"]').click()`);
    await eventually(()=>evaluate('location.pathname==="/login"'),'signup preserves next');
    assert.equal(await evaluate('new URL(location.href).searchParams.get("next")'),`/shared/${runId}`);
    // Authentication itself is covered by the email/Google HTTP browser suites.
    await send('Network.setCookie',{name:'__client_uat',value:'1',url:base});
      await send('Network.setCookie',{name:'__clerk_db_jwt',value:'fixture',url:base});
      await send('Network.setCookie',{name:'__session',value:guestToken,url:base,httpOnly:true,sameSite:'Lax'});
    await send('Page.navigate',{url:`${base}/shared/${runId}`});
    await eventually(()=>evaluate('!!document.querySelector("#shared-comment")'),'invitation resumes after signup');
    if(hostToken)await eventually(()=>evaluate('document.body.innerText.includes("Check delivery failures before accepting the implementation.")'),'guest receives explicitly shared briefing');
    assert.equal(await evaluate('location.hash'),'');
    assert.equal(await evaluate(`sessionStorage.getItem('shared-chat-invite:${runId}')`),null);
    assert.equal(await evaluate('document.body.innerText.includes("PRIVATE TOOL OUTPUT")'),false);
    for(const width of [1440,390,320]){
      await send('Emulation.setDeviceMetricsOverride',{width,height:900,deviceScaleFactor:1,mobile:false});await delay(100);
      assert.ok(await evaluate('document.documentElement.scrollWidth<=innerWidth'),'shared chat fits '+width);
      if(width!==320)await writeFile(join(tmpdir(),`multiplayer-shared-chat-${width}.png`),Buffer.from((await send('Page.captureScreenshot')).data,'base64'));
    }
    await evaluate(`(()=>{const el=document.querySelector('#shared-comment');Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(el,'Browser feedback from an external guest');el.dispatchEvent(new Event('input',{bubbles:true}));})()`);
    await delay(100);await evaluate(`document.querySelector('button[type=submit]').click()`);
    await eventually(()=>evaluate('document.querySelector("#shared-comment")?.value===""&&document.body.innerText.includes("Browser feedback from an external guest")'),'comment visible');
    await revoke();
    await eventually(()=>evaluate('!document.querySelector("#shared-comment")&&document.body.innerText.includes("This chat needs an invitation")'),'revocation clears stale page');
    assert.equal(await evaluate('document.body.innerText.includes("Review this change")'),false,'revoked content cleared');
    if(shareByLink){
      // Anyone with the link: no account needed to read; commenting asks to sign in.
      const link=await shareByLink();
      await send('Network.deleteCookies',{name:'__session',url:base});
      await send('Page.navigate',{url:`${base}/shared/${runId}#link=${link}`});
      await eventually(()=>evaluate('document.body.innerText.includes("Review this change")&&document.body.innerText.includes("anyone with the link")'),'link opens without signing in');
      assert.equal(await evaluate('!!document.querySelector("#shared-comment")'),false,'signed-out link viewers cannot comment');
      assert.ok(await evaluate('document.body.innerText.includes("to join the discussion")'));
      assert.equal(await evaluate('document.body.innerText.includes("PRIVATE TOOL OUTPUT")'),false);
      await send('Emulation.setDeviceMetricsOverride',{width:390,height:900,deviceScaleFactor:1,mobile:false});await delay(100);
      assert.ok(await evaluate('document.documentElement.scrollWidth<=innerWidth'),'link view fits a phone');
      await writeFile(join(tmpdir(),'multiplayer-shared-chat-link-390.png'),Buffer.from((await send('Page.captureScreenshot')).data,'base64'));
    }
    assert.deepEqual(errors,[]);
    console.log('PASS: real browser invitation/signup return, mobile layouts, comments, and revocation without refresh.');
  }finally{
    if(socket?.readyState===WebSocket.OPEN)socket.send(JSON.stringify({id:0,method:'Browser.close'}));socket?.close();
    if(chrome.exitCode===null){chrome.kill('SIGTERM');await Promise.race([once(chrome,'exit'),delay(3000)]);}
    await rm(directory,{recursive:true,force:true,maxRetries:10,retryDelay:100});
  }
}
