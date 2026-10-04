import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

export async function googleBrowserCheck({ base, flow, callbackPath, email, authorizeDesktop }) {
  const directory = await mkdtemp(join(tmpdir(), 'multiplayer-google-browser-'));
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
    await send('Runtime.enable'); await send('Page.enable'); await send('Network.enable');
    const [cookieName, cookieValue] = flow.jar.split('=');
    await send('Network.setCookie', { name: cookieName, value: cookieValue, url: base, path: '/', secure: true, httpOnly: true, sameSite: 'Lax' });
    await send('Emulation.setDeviceMetricsOverride',{width:390,height:844,deviceScaleFactor:1,mobile:true});
    await send('Page.navigate',{url:base+callbackPath});
    await eventually(()=>evaluate(`location.pathname==='/workspace'`),'Google signup reaches workspace without another form');
    assert.equal(await evaluate(`fetch('/api/auth/me').then(r=>r.json()).then(body=>body.user.email)`),email);
    console.log('PASS: mobile Google signup enters the workspace directly without a username or password.');

    await evaluate(`fetch('/api/auth/me',{method:'DELETE'})`);
    await send('Page.addScriptToEvaluateOnNewDocument',{source:'window.desktop={isDesktop:true};window.open=url=>{window.__googleBrowserUrl=url;return null;};'});
    await send('Emulation.setDeviceMetricsOverride',{width:1280,height:900,deviceScaleFactor:1,mobile:false});
    const returnPath='/workspace?org=desktop-team&connections=desktop-project';
    await send('Page.navigate',{url:base+'/login?next='+encodeURIComponent(returnPath)});
    await eventually(()=>evaluate(`Array.from(document.querySelectorAll('button')).some(b=>b.textContent.trim()==='Continue with Google'&&!b.disabled)`),'Google button');
    await button('Continue with Google');
    await eventually(()=>evaluate('!!window.__googleBrowserUrl'),'desktop opens the system-browser link');
    const browserUrl=new URL(await evaluate('window.__googleBrowserUrl'));
    assert.equal(browserUrl.origin,base); assert.equal(browserUrl.pathname,'/login');
    assert.equal(browserUrl.searchParams.get('next'),returnPath);
    assert.equal(browserUrl.searchParams.has('verifier'),false);
    await button('Complete sign-in');
    await eventually(()=>evaluate(`document.body.innerText.includes('browser first')`),'approval is required before redeeming');
    await authorizeDesktop(browserUrl.searchParams.get('desktop'));
    await button('Complete sign-in');
    await eventually(()=>evaluate(`location.pathname+location.search===${JSON.stringify(returnPath)}`),'desktop finishes login at the selected project');
    assert.equal(await evaluate(`fetch('/api/auth/me').then(r=>r.json()).then(body=>body.user.email)`),email);
    assert.deepEqual(errors,[],'no browser runtime errors');
    console.log('PASS: desktop Google button opens browser, preserves project, handles pending approval, then redeems the session.');

    await send('Page.navigate',{url:base+'/login?google=restart'});
    await eventually(()=>evaluate(`Array.from(document.querySelectorAll('button')).some(b=>b.textContent.trim()==='Continue with Google'&&!b.disabled)`),'desktop login screenshot');
    await writeFile('/tmp/multiplayer-google-login-desktop.png',Buffer.from((await send('Page.captureScreenshot')).data,'base64'));
    await send('Emulation.setDeviceMetricsOverride',{width:390,height:844,deviceScaleFactor:1,mobile:true});
    await delay(150);
    await writeFile('/tmp/multiplayer-google-login-mobile.png',Buffer.from((await send('Page.captureScreenshot')).data,'base64'));
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
