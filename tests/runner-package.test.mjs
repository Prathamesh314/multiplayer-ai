import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {mkdtemp,mkdir,readFile,readdir,rm,symlink,copyFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve,delimiter} from 'node:path';

const run=promisify(execFile);
const root=resolve(import.meta.dirname,'..');

test('downloaded runner installs without a checkout and pairs/starts from unrelated folders',async () => {
  const directory=await mkdtemp(join(tmpdir(),'mp-runner-package-'));
  const packageBytes=await readFile(join(root,'public/downloads/multiplayer-ai-runner.tgz'));
  const requests=[];
  const server=createServer(async(req,res)=>{
    if(req.url==='/downloads/multiplayer-ai-runner.tgz'){
      res.writeHead(200,{'content-type':'application/octet-stream'}).end(packageBytes);return;
    }
    let data='';for await(const chunk of req)data+=chunk;
    requests.push({path:req.url,body:JSON.parse(data||'{}'),authorization:req.headers.authorization});
    res.setHeader('content-type','application/json');
    if(req.url==='/api/runner/pair')res.end(JSON.stringify({token:'test-only-device-token',device:{id:'fixture'}}));
    else if(req.url==='/api/runner/heartbeat')res.end('{}');
    else res.writeHead(401).end('{}'); // Revoke after its first successful heartbeat.
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  try {
    const origin=`http://127.0.0.1:${server.address().port}`;
    const first=join(directory,'unrelated first folder'),second=join(directory,'another folder');
    const prefix=join(directory,'installed'),tools=join(directory,'tools');
    await Promise.all([first,second,tools].map(path=>mkdir(path,{recursive:true})));
    const npmCli=process.env.npm_execpath;
    assert.ok(npmCli,'Run through npm run test:runner-package');
    await run(process.execPath,[npmCli,'install','--global','--prefix',prefix,'--ignore-scripts','--no-audit','--no-fund',`${origin}/downloads/multiplayer-ai-runner.tgz`],{
      cwd:first,env:{...process.env,npm_config_cache:join(directory,'npm-cache'),npm_config_registry:'http://127.0.0.1:1'},timeout:30000,
    });
    const binDirectory=process.platform==='win32'?prefix:join(prefix,'bin');
    const installed=join(prefix,...(process.platform==='win32'?[]:['lib']),'node_modules','multiplayer-ai-runner');
    assert.deepEqual((await readdir(installed)).sort(),['README.md','package.json','runner.cjs']);
    const manifest=JSON.parse(await readFile(join(installed,'package.json'),'utf8'));
    assert.equal(manifest.dependencies,undefined);
    assert.equal(manifest.scripts,undefined);
    if(process.platform==='win32')await copyFile(process.execPath,join(tools,'node.exe'));
    else await symlink(process.execPath,join(tools,'node'));
    const config=join(directory,'profile','runner.json');
    const env={...process.env,PATH:[binDirectory,tools].join(delimiter),RUNNER_CONFIG:config};
    // On POSIX invoke the installed command by name through PATH. Windows npm
    // provides a .cmd shim; also verify its presence before invoking the entry.
    const command=process.platform==='win32'?process.execPath:'multiplayer-ai-runner';
    const extra=process.platform==='win32'?[join(installed,'runner.cjs')]:[];
    if(process.platform==='win32')assert.ok((await readdir(prefix)).includes('multiplayer-ai-runner.cmd'));
    const invoke=(args,cwd=first)=>run(command,[...extra,...args],{cwd,env,timeout:15000});
    assert.match((await invoke(['--help'])).stdout,/Works from any directory/);
    assert.equal((await invoke(['--version'],second)).stdout.trim(),manifest.version);
    await invoke(['pair','--server',origin,'--code','RN-TEST-CODE','--data',join(directory,'data'),'--workspaces',join(directory,'workspaces')]);
    const saved=JSON.parse(await readFile(config,'utf8'));
    assert.equal(saved.server,origin);
    assert.equal(saved.workspacesDir,join(directory,'workspaces'));
    assert.equal((await invoke(['workspaces','--json'],second)).stdout.trim(),'[]');
    await assert.rejects(invoke(['start'],second),error=>{
      assert.equal(error.code,1);
      assert.match(error.stdout,/online as/);
      assert.match(error.stderr,/re-pair/);
      assert.ok(!error.stderr.includes('test-only-device-token'));
      return true;
    });
    assert.equal(requests[0].body.code,'RN-TEST-CODE');
    assert.deepEqual(requests.map(r=>r.path),['/api/runner/pair','/api/runner/heartbeat','/api/runner/claim']);
    assert.equal(requests[1].authorization,'Bearer test-only-device-token');
    assert.equal(requests[2].authorization,'Bearer test-only-device-token');
    assert.deepEqual(await readdir(first),[],'no package.json or checkout created in the working folder');
    assert.deepEqual(await readdir(second),[]);
  } finally {
    server.closeAllConnections();await new Promise(resolve=>server.close(resolve));
    await rm(directory,{recursive:true,force:true});
  }
});
