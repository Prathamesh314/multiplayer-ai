import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
export const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
export async function eventually(task,label){
  for(let i=0;i<200;i++){try{if(await task())return;}catch{}await delay(100);}
  throw Error('Timed out: '+label);
}
export async function docsBrowser(){
  const base=process.env.DOCS_BASE_URL??'http://127.0.0.1:3118';
  assert.ok(['localhost','127.0.0.1'].includes(new URL(base).hostname),'Documentation captures and checks must use a local server.');
  const directory=await mkdtemp(join(tmpdir(),'multiplayer-docs-'));
  let server,chrome,socket;let output='';const errors=[];
  async function close(){
    socket?.close();
    for(const child of [chrome,server])if(child&&child.exitCode===null){child.kill('SIGTERM');await Promise.race([once(child,'exit'),delay(3000)]);if(child.exitCode===null)child.kill('SIGKILL');}
    await rm(directory,{recursive:true,force:true});
  }
  try{
    if(process.argv.includes('--start-server')){
      server=spawn(process.execPath,['node_modules/next/dist/bin/next','start','-H','127.0.0.1','-p',new URL(base).port],{
        env:{...process.env,SIGNUP_MODE:'open'},stdio:['ignore','pipe','pipe'],
      });
      for(const stream of [server.stdout,server.stderr])stream.on('data',chunk=>{output=(output+chunk).slice(-6000);});
    }
    await eventually(async()=>{if(server?.exitCode!=null)throw Error(output);return(await fetch(base+'/docs')).ok;},'documentation server');
    chrome=spawn(process.env.CHROME_BIN??'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',[
      '--headless=new','--disable-gpu','--no-first-run','--no-default-browser-check','--remote-debugging-port=0',`--user-data-dir=${directory}`,'about:blank',
    ],{stdio:'ignore'});
    let port;await eventually(async()=>{port=(await readFile(join(directory,'DevToolsActivePort'),'utf8')).split('\n')[0];return !!port;},'browser');
    const targets=await(await fetch(`http://127.0.0.1:${port}/json`)).json();
    socket=new WebSocket(targets.find(target=>target.type==='page').webSocketDebuggerUrl);await once(socket,'open');
    let sequence=0;const pending=new Map();
    socket.onmessage=event=>{const message=JSON.parse(event.data),item=pending.get(message.id);
      if(message.method==='Runtime.exceptionThrown')errors.push(message.params.exceptionDetails.exception?.description??message.params.exceptionDetails.text);
      if(item){pending.delete(message.id);clearTimeout(item.timer);if(message.error)item.reject(Error(message.error.message));else item.resolve(message.result);}
    };
    const send=(method,params={})=>new Promise((resolve,reject)=>{const id=++sequence;const timer=setTimeout(()=>{pending.delete(id);reject(Error('CDP timeout: '+method));},20000);pending.set(id,{resolve,reject,timer});socket.send(JSON.stringify({id,method,params}));});
    const evaluate=async expression=>{const result=await send('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true});if(result.exceptionDetails)throw Error(JSON.stringify(result.exceptionDetails));return result.result.value;};
    const click=async selector=>{await eventually(()=>evaluate(`!!document.querySelector(${JSON.stringify(selector)})`),selector);await evaluate(`document.querySelector(${JSON.stringify(selector)}).click()`);await delay(100);};
    const button=async text=>{
      const expression=`[...document.querySelectorAll('button')].find(button=>button.textContent.trim()===${JSON.stringify(text)}&&!button.disabled)`;
      await eventually(()=>evaluate(`!!(${expression})`),'button '+text);await evaluate(`(${expression}).click()`);await delay(100);
    };
    const type=async(selector,value)=>{await evaluate(`(()=>{const el=document.querySelector(${JSON.stringify(selector)});Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el),'value').set.call(el,${JSON.stringify(value)});el.dispatchEvent(new Event('input',{bubbles:true}));})()`);await delay(100);};
    const viewport=async(width=1440,height=960)=>{await send('Emulation.setDeviceMetricsOverride',{width,height,deviceScaleFactor:1,mobile:width<600});await delay(150);};
    const navigate=async(path,ready)=>{await send('Page.navigate',{url:path.startsWith('file:')?path:base+path});await eventually(()=>evaluate(ready??'!!document.body'),'document '+path);await evaluate('document.fonts.ready');await delay(150);};
    await send('Page.enable');await send('Runtime.enable');await viewport();
    return {base,send,evaluate,click,button,type,viewport,navigate,errors,close};
  }catch(cause){await close();throw cause;}
}
