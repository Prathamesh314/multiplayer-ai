// Exercise the visible download controls against a production page, locally or live.
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
const base=process.env.DOWNLOADS_BASE_URL||'http://127.0.0.1:3122';
const available=process.env.DOWNLOADS_EXPECT_AVAILABLE==='1';
const directory=await mkdtemp(join(tmpdir(),'multiplayer-download-ui-'));
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
let chrome,socket,output='';
const server=process.argv.includes('--start-server')?spawn(process.execPath,['node_modules/next/dist/bin/next','start','-H','127.0.0.1','-p',new URL(base).port],{env:process.env,stdio:['ignore','pipe','pipe']}):null;
for(const stream of [server?.stdout,server?.stderr])stream?.on('data',chunk=>{output=(output+chunk).slice(-4000);});
async function eventually(task,label){for(let i=0;i<150;i++){if(server?.exitCode!=null)throw Error(output);try{if(await task())return;}catch{}await delay(100);}throw Error('Timed out: '+label);}
try {
  if(server)await eventually(async()=>(await fetch(base)).ok,'website');
  chrome=spawn(process.env.CHROME_BIN||'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',[
    '--headless=new','--disable-gpu','--no-first-run','--no-default-browser-check','--remote-debugging-port=0',`--user-data-dir=${directory}`,
    ...(process.env.DOWNLOADS_HOST_RESOLVER?[`--host-resolver-rules=${process.env.DOWNLOADS_HOST_RESOLVER}`]:[]),'about:blank'],{stdio:'ignore'});
  let port;await eventually(async()=>{port=(await readFile(join(directory,'DevToolsActivePort'),'utf8')).split('\n')[0];return !!port;},'browser');
  const targets=await(await fetch('http://127.0.0.1:'+port+'/json')).json();
  socket=new WebSocket(targets.find(t=>t.type==='page').webSocketDebuggerUrl);await once(socket,'open');
  const pending=new Map(),events=[];let sequence=0;
  socket.onmessage=event=>{const message=JSON.parse(event.data),item=pending.get(message.id);if(item){pending.delete(message.id);clearTimeout(item.timer);if(message.error)item.reject(Error(message.error.message));else item.resolve(message.result);}else if(message.method?.startsWith('Browser.download'))events.push(message);};
  const send=(method,params={})=>new Promise((resolve,reject)=>{const id=++sequence,timer=setTimeout(()=>reject(Error('CDP timeout: '+method)),20000);pending.set(id,{resolve,reject,timer});socket.send(JSON.stringify({id,method,params}));});
  const evaluate=async expression=>{const r=await send('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true});if(r.exceptionDetails)throw Error(JSON.stringify(r.exceptionDetails));return r.result.value;};
  await send('Page.enable');await send('Runtime.enable');
  await send('Page.navigate',{url:base+'/#download'});
  await eventually(()=>evaluate(`!!document.querySelector('#download h2')`),'download section');
  for(const width of [1440,390]){
    await send('Emulation.setDeviceMetricsOverride',{width,height:1000,deviceScaleFactor:1,mobile:width<600});
    // Measure only once the new viewport is in effect and layout has settled
    // (fonts loaded, two frames painted), not after a fixed delay that a slow
    // CI machine can outrun; the overflow assertion itself stays exact.
    await eventually(()=>evaluate(`innerWidth===${width}`),`viewport ${width}px`);
    await evaluate('document.fonts.ready.then(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(()=>resolve(true)))))');
    assert.equal(await evaluate('document.documentElement.scrollWidth<=innerWidth'),true,`no overflow at ${width}px`);
    assert.equal(await evaluate(`document.querySelectorAll('#download article').length`),3);
  }
  const links=await evaluate(`[...document.querySelectorAll('#download a[aria-label^="Download "]')].map(a=>({url:a.href,label:a.getAttribute('aria-label')}))`);
  assert.equal(links.length,available?4:0);
  assert.equal(await evaluate(`!!document.querySelector('#download a[href*="example.com"]')`),false);
  if(!available){
    assert.equal(await evaluate(`(document.querySelector('#download').innerText.match(/Coming soon/g)||[]).length`),4);
    console.log('PASS: all four unavailable downloads are clearly disabled, with no fake URLs; desktop/mobile layout fits.');
  } else {
    // One button for this computer, then how to install it (including the first-launch prompt for unsigned previews).
    await eventually(()=>evaluate(`[...document.querySelectorAll('#download a')].some(a=>a.textContent.startsWith('Download for '))`),'download for this computer');
    const steps=await evaluate(`document.querySelector('#download ol[aria-label^="Install on"]')?.innerText??''`);
    assert.match(steps,/Sign in/);
    if(process.platform==='darwin')assert.match(steps,/Open Anyway/,'the macOS first-launch prompt is explained');
    for(const link of links){
      const result=await evaluate(`(async()=>{const head=await fetch(${JSON.stringify(link.url)},{method:'HEAD'});const range=await fetch(${JSON.stringify(link.url)},{headers:{Range:'bytes=0-15'}});return {status:head.status,length:Number(head.headers.get('content-length')),attachment:head.headers.get('content-disposition'),range:range.status,bytes:(await range.arrayBuffer()).byteLength};})()`);
      assert.equal(result.status,200,link.label);assert.ok(result.length>10_000_000,link.label);assert.equal(result.attachment,'attachment');assert.equal(result.range,206);assert.equal(result.bytes,16);
    }
    await send('Browser.setDownloadBehavior',{behavior:'allow',downloadPath:directory,eventsEnabled:true});
    await evaluate(`document.querySelector('#download a[aria-label^="Download "]').click()`);
    await eventually(()=>events.some(e=>e.method==='Browser.downloadWillBegin'),'browser download start');
    const started=events.find(e=>e.method==='Browser.downloadWillBegin').params;
    assert.match(started.suggestedFilename,/-mac-arm64-preview\.dmg$/);
    await send('Browser.cancelDownload',{guid:started.guid});
    console.log('PASS: all four live installer links support HTTPS and resume; clicking the Mac button starts the correct browser download.');
  }
} finally {
  socket?.close();for(const child of [chrome,server])if(child&&child.exitCode===null){child.kill('SIGTERM');await Promise.race([once(child,'exit'),delay(3000)]);}
  await rm(directory,{recursive:true,force:true});
}
