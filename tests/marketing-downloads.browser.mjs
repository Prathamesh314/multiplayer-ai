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
    assert.equal(await evaluate(`document.querySelectorAll('#download [role=tablist][aria-label="Your computer"] [role=tab]').length`),4,'a command for each of the four computers');
  }
  // One command per computer: Apple Silicon and Intel Macs, Windows and Linux.
  const command=async label=>{
    await evaluate(`[...document.querySelectorAll('#download [role=tab]')].find(t=>t.textContent.startsWith(${JSON.stringify(label)})).click()`);
    return evaluate(`document.querySelector('#download [role=tabpanel] code')?.textContent??''`);
  };
  const links=await evaluate(`[...document.querySelectorAll('#download details[aria-label="Regular downloads"] a')].map(a=>({url:a.href,label:a.textContent}))`);
  assert.equal(await evaluate(`!!document.querySelector('#download a[href*="example.com"]')`),false);
  if(!available){
    assert.equal(links.length,0);
    assert.match(await evaluate(`document.querySelector('#download').innerText`),/Installers are coming soon/);
    console.log('PASS: with no published release the section says installers are coming soon, with no fake URLs; desktop/mobile layout fits.');
  } else {
    const site=new URL(base).origin;
    assert.match(await command('macOS · Apple Silicon'),new RegExp(`curl -fsSL ${site}/install\\.sh \\| sh -s -- mac-arm64$`));
    assert.match(await command('macOS · Intel'),/\| sh -s -- mac-x64$/);
    assert.match(await command('Windows'),new RegExp(`irm ${site}/install\\.ps1 \\| iex$`));
    assert.match(await command('Linux'),/\| sh -s -- linux$/);
    assert.match(await evaluate(`(await fetch('/install/latest')).text()`),/^https:\/\/.+\/\n$/,'the scripts can find the current release');
    for(const path of ['/install.sh','/install.ps1']){
      const response=await evaluate(`fetch(${JSON.stringify(path)}).then(async r=>({status:r.status,type:r.headers.get('content-type'),body:await r.text()}))`);
      assert.equal(response.status,200,path);assert.match(response.type,/^text\/plain/,path);assert.match(response.body,/SHA256SUMS/,path);
    }
    for(const link of links){
      const result=await evaluate(`(async()=>{const head=await fetch(${JSON.stringify("__URL__")},{method:'HEAD'});return {status:head.status,length:Number(head.headers.get('content-length'))};})()`.replace("__URL__",link.url));
      assert.equal(result.status,200,link.label);assert.ok(result.length>10_000_000,link.label);
    }
    console.log('PASS: install commands for Apple Silicon, Intel, Windows and Linux, served scripts and the current release, and live direct downloads.');
  }
} finally {
  socket?.close();for(const child of [chrome,server])if(child&&child.exitCode===null){child.kill('SIGTERM');await Promise.race([once(child,'exit'),delay(3000)]);}
  await rm(directory,{recursive:true,force:true});
}
