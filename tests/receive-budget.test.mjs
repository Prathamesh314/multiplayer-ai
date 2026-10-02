import assert from 'node:assert/strict';
import {test} from 'node:test';
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomBytes} from 'node:crypto';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {receiveBudgetHooks} from '../app/lib/storage/receive-budget.ts';
const exec=promisify(execFile);
test('real receive-pack rejects excessive quarantine without changing accepted refs or retaining rejected objects',async()=>{
  const root=await mkdtemp(join(tmpdir(),'mp-receive-budget-'));process.env.MULTIPLAYER_AI_DATA=root;
  const work=join(root,'work'),bare=join(root,'repo.git');
  const git=async(cwd,args)=>(await exec('git',['-c','commit.gpgsign=false','-c','user.name=Fixture','-c','user.email=fixture@example.test',...args],{cwd})).stdout.trim();
  try {
    await mkdir(work);await git(work,['init','-b','main']);await git(root,['init','--bare',bare]);
    await git(bare,['config','core.hooksPath',await receiveBudgetHooks(16384)]);
    await writeFile(join(work,'small.txt'),'accepted\n');await git(work,['add','.']);await git(work,['commit','-m','Initial']);
    await git(work,['push',bare,'HEAD:refs/heads/main']);const accepted=await git(bare,['rev-parse','refs/heads/main']);
    await writeFile(join(work,'large.bin'),randomBytes(128*1024));await git(work,['add','.']);await git(work,['commit','-m','Too large']);
    const rejected=await git(work,['rev-parse','HEAD']);
    await assert.rejects(git(work,['push',bare,'HEAD:refs/heads/main']),/storage allowance|pre-receive hook declined/);
    assert.equal(await git(bare,['rev-parse','refs/heads/main']),accepted);
    await assert.rejects(git(bare,['cat-file','-e',rejected]));
    await git(bare,['fsck','--full']);
  } finally {delete process.env.MULTIPLAYER_AI_DATA;await rm(root,{recursive:true,force:true});}
});
