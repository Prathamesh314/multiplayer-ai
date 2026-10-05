import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

export async function emailBrowserCheck({ base, codeFor, releaseCooldown }) {
  const directory = await mkdtemp(join(tmpdir(), 'multiplayer-email-browser-'));
  let chrome, socket;
  const eventually = async (task, label) => { for (let count=0; count<150; count++) { try { if (await task()) return; } catch {} await delay(100); } throw Error('Timed out: '+label); };
  try {
    chrome = spawn(process.env.CHROME_BIN ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', [
      '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check', '--remote-debugging-port=0', `--user-data-dir=${directory}`, 'about:blank',
    ], { stdio: 'ignore' });
    let port;
    await eventually(async () => { port=(await readFile(join(directory, 'DevToolsActivePort'), 'utf8')).split('\n')[0]; return !!port; }, 'browser startup');
    const targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
    socket = new WebSocket(targets.find(target=>target.type==='page').webSocketDebuggerUrl); await once(socket,'open');
    let sequence=0; const pending=new Map(), errors=[];
    socket.onmessage=event=>{const message=JSON.parse(event.data); if(message.method==='Runtime.exceptionThrown')errors.push(message.params.exceptionDetails.text); const operation=pending.get(message.id); if(operation){pending.delete(message.id);clearTimeout(operation.timer);if(message.error)operation.reject(Error(message.error.message));else operation.resolve(message.result);}};
    const send=(method,params={})=>new Promise((resolve,reject)=>{const id=++sequence,timer=setTimeout(()=>{pending.delete(id);reject(Error('CDP timeout: '+method));},15000);pending.set(id,{resolve,reject,timer});socket.send(JSON.stringify({id,method,params}));});
    const evaluate=async expression=>{const result=await send('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true});if(result.exceptionDetails)throw Error(result.exceptionDetails.text);return result.result.value;};
    const button = text => evaluate(`Array.from(document.querySelectorAll('button')).find(button=>button.textContent.trim()===${JSON.stringify(text)})?.click()`);
    const fill=async(selector,value)=>{await evaluate(`(()=>{const el=document.querySelector(${JSON.stringify(selector)});Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(el,${JSON.stringify(value)});el.dispatchEvent(new Event('input',{bubbles:true}));})()`);await delay(100);};
    await send('Runtime.enable');await send('Page.enable');
    const email='browser-verification@example.test', password='fixture-long-password', next='/workspace?org=verification-team';
    await send('Emulation.setDeviceMetricsOverride',{width:390,height:844,deviceScaleFactor:1,mobile:true});
    await send('Page.navigate',{url:base+'/login?mode=signup&next='+encodeURIComponent(next)});
    await eventually(()=>evaluate(`!!document.querySelector('input[type=email]')&&!document.querySelector('button[type=submit]').disabled`),'signup form');
    await fill('input[type=email]',email);await fill('input[type=password]',password);await button('Create account');
    await eventually(()=>evaluate(`!!document.querySelector('input[autocomplete=one-time-code]')`),'email verification form');
    assert.equal(await evaluate(`fetch('/api/auth/me').then(r=>r.json()).then(body=>body.user)`),null,'workspace access waits for the code');
    assert.ok(await evaluate('document.documentElement.scrollWidth <= window.innerWidth'),'mobile code form fits');
    assert.ok(await evaluate(`Array.from(document.querySelectorAll('button')).some(b=>b.textContent.includes('Resend code in')&&b.disabled)`));
    await writeFile('/tmp/multiplayer-email-verification-mobile.png',Buffer.from((await send('Page.captureScreenshot')).data,'base64'));
    const oldCode=await codeFor(email);
    await fill('input[autocomplete=one-time-code]',oldCode==='000000'?'000001':'000000');await button('Verify & sign in');
    await eventually(()=>evaluate(`document.body.innerText.includes('That code is incorrect')`),'incorrect-code feedback');
    await releaseCooldown(email);
    await send('Page.reload');
    await eventually(()=>evaluate(`Array.from(document.querySelectorAll('button')).some(b=>b.textContent.trim()==='Resend code'&&!b.disabled)`),'pending challenge survives reload');
    await button('Resend code');
    await eventually(async()=>await codeFor(email)!==oldCode,'replacement code sent');
    await eventually(()=>evaluate(`Array.from(document.querySelectorAll('button')).some(b=>b.textContent.includes('Resend code in'))`),'resend cooldown restored');
    await fill('input[autocomplete=one-time-code]',oldCode);await button('Verify & sign in');
    await eventually(()=>evaluate(`document.body.innerText.includes('That code is incorrect')`),'old code rejected after resend');
    await fill('input[autocomplete=one-time-code]',await codeFor(email));await button('Verify & sign in');
    await eventually(()=>evaluate(`location.pathname+location.search===${JSON.stringify(next)}`),'verified user enters the requested workspace');
    assert.equal(await evaluate(`fetch('/api/auth/me').then(r=>r.json()).then(body=>body.user.email)`),email);
    await evaluate(`fetch('/api/auth/me',{method:'DELETE'})`);
    await send('Page.navigate',{url:base+'/login'});
    await eventually(()=>evaluate(`!!document.querySelector('input[type=email]')&&!document.querySelector('button[type=submit]').disabled`),'returning login');
    await fill('input[type=email]',email);await fill('input[type=password]',password);await button('Sign in');
    await eventually(()=>evaluate(`location.pathname==='/workspace'`),'verified user signs in without another code');
    assert.deepEqual(errors,[],'no browser runtime errors');
    console.log('PASS: mobile signup, wrong code, page refresh, resend, old-code rejection, workspace return and subsequent password-only login.');

  } finally {
    const running = chrome && chrome.exitCode === null && chrome.signalCode === null;
    const exited = running ? once(chrome, 'exit') : Promise.resolve();
    // Let Chromium flush and close its profile before removing it. Killing the
    // launcher alone can leave child processes writing into Default/ on Linux.
    if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify({id:0,method:'Browser.close'}));
    else if (running) chrome.kill('SIGTERM');
    if (running && !await Promise.race([exited.then(()=>true),delay(3000).then(()=>false)])) {
      chrome.kill('SIGKILL');
      await exited;
    }
    socket?.close();
    await rm(directory,{recursive:true,force:true,maxRetries:10,retryDelay:100});
  }
}
