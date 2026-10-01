// Real Git operations in disposable bare repositories. No database or app data.
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {objectGit,objectText,putBlob,putBlobs} from '../app/lib/git/objects.ts';

const root=await mkdtemp(join(tmpdir(),'mp-upload-bench-'));
try {
  const trees=[];
  for(const [mode,count] of [['legacy',1000],['batch',1000],['batch',10000]]) {
    const bare=join(root,`${mode}-${count}.git`);
    await objectGit(root,['init','--bare',bare]);
    const index={GIT_INDEX_FILE:join(bare,'import.index')};
    await objectGit(bare,['read-tree','--empty'],undefined,index);
    const files=Array.from({length:count},(_,i)=>({path:`src/dir${i%10}/file${i}.ts`,
      bytes:Buffer.from(`export const item${i} = ${JSON.stringify('some project code '.repeat(60))};\n`)}));
    const start=performance.now();
    for(let offset=0;offset<count;offset+=200) {
      const batch=files.slice(offset,offset+200);
      if(mode==='legacy')for(const file of batch)await putBlob(bare,index,file.path,file.bytes);
      else await putBlobs(bare,index,batch);
    }
    const tree=await objectText(bare,['write-tree'],undefined,index);
    if(count===1000)trees.push(tree);
    console.log(JSON.stringify({mode,files:count,bytes:files.reduce((n,f)=>n+f.bytes.length,0),ms:Math.round(performance.now()-start),tree}));
  }
  assert.equal(trees[0],trees[1],'optimized import must produce the identical tree');
} finally {await rm(root,{recursive:true,force:true});}
