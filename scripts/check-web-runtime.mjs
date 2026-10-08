import {setTimeout as delay} from 'node:timers/promises';
import {fileURLToPath} from 'node:url';
import {resolve} from 'node:path';

export async function checkWebRuntime({base='http://127.0.0.1:3000',timeoutMs=90_000,pollMs=500}={}) {
  const deadline=Date.now()+timeoutMs;
  let ready=false;
  while(Date.now()<deadline) {
    try {
      const response=await fetch(base+'/health/ready',{signal:AbortSignal.timeout(Math.max(1,Math.min(2000,deadline-Date.now())))});
      await response.arrayBuffer();
      if(response.status===200){ready=true;break;}
    } catch { /* The candidate may still be starting. */ }
    await delay(Math.min(pollMs,Math.max(0,deadline-Date.now())));
  }
  if(!ready)throw new Error('Candidate web server did not become ready; keep the current release running.');
  for(const path of ['/','/login','/workspace']) {
    const response=await fetch(base+path,{signal:AbortSignal.timeout(5000),redirect:'manual'});
    await response.arrayBuffer();
    if(response.status!==200)throw new Error(`Candidate page ${path} returned HTTP ${response.status}.`);
  }
  console.log('Candidate web runtime and public pages are ready.');
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url))checkWebRuntime().catch(error=>{console.error(error.message);process.exitCode=1;});
