import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, mkdir, writeFile, readFile, copyFile, rm, access} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';

test('Docker COPY excludes secret and runtime canaries, but keeps source and env templates', {timeout:60000}, async()=>{
  const directory=await mkdtemp(join(tmpdir(),'multiplayer-context-test-'));
  const context=join(directory,'context'), exported=join(directory,'exported');
  try {
    await mkdir(context);
    await copyFile(new URL('../.dockerignore',import.meta.url),join(context,'.dockerignore'));
    const excluded=['.env','.env.local','.ssh/id_rsa','.aws/credentials','nested/.env','nested/.env.production',
      '.multiplayer-ai/repos/private.git/config','.runner-build/runner.cjs','.next-handoff-test/private','.desktop-build/settings',
      'desktop-dist/private','backup.dump','docs/private.local.md','secret.pem'];
    const included=['app/source.ts','.env.example','nested/.env.example','db/migrations/fixture.sql'];
    for(const path of [...excluded,...included]) {
      const file=join(context,path);await mkdir(join(file,'..'),{recursive:true});
      await writeFile(file,excluded.includes(path)?'FAKE-SECRET-CANARY':'safe source');
    }
    await writeFile(join(context,'Dockerfile'),'FROM scratch\nCOPY . /\n');
    await promisify(execFile)('docker',['build','--no-cache','--output',`type=local,dest=${exported}`,context],{timeout:50000});
    for(const path of excluded)await assert.rejects(access(join(exported,path)),{code:'ENOENT'},path);
    for(const path of included)assert.equal(await readFile(join(exported,path),'utf8'),'safe source',path);
  } finally {await rm(directory,{recursive:true,force:true});}
});
