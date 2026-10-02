import assert from 'node:assert/strict';
import {test} from 'node:test';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {localReleaseEnvironment,releaseChecks} from '../desktop/release-preflight.mjs';
test('release admission rejects missing production inputs and insecure URLs',()=>{
  assert.ok(releaseChecks({},'darwin').length>=4);
  const valid={DESKTOP_WORKSPACE_URL:'https://workspace.example.test',DESKTOP_UPDATE_URL:'https://downloads.example.test/app/',CSC_NAME:'Developer ID Application: Test',APPLE_ID:'test@example.test',APPLE_APP_SPECIFIC_PASSWORD:'fake-test-value',APPLE_TEAM_ID:'TEST'};
  assert.deepEqual(releaseChecks(valid,'darwin'),[]);
  for(const url of ['http://localhost:3000','https://localhost','https://workspace.example.test/path','https://name:secret@workspace.example.test','https://workspace.example.test/?key=secret']) assert.ok(releaseChecks({...valid,DESKTOP_WORKSPACE_URL:url},'darwin').length);
  assert.ok(releaseChecks({...valid,CSC_NAME:'-'},'darwin').length);
  assert.ok(releaseChecks(valid,'linux').length);
});
test('local signing file is parsed as data and cannot overwrite process/CI credentials',async()=>{
  const directory=await mkdtemp(join(tmpdir(),'mp-release-env-')),file=join(directory,'signing.env');
  try {
    await writeFile(file,'CSC_NAME="$(must-not-execute)"\nDESKTOP_UPDATE_URL=https://local.example.test\n');
    const env=localReleaseEnvironment({DESKTOP_UPDATE_URL:'https://ci.example.test'},file);
    assert.equal(env.CSC_NAME,'$(must-not-execute)');assert.equal(env.DESKTOP_UPDATE_URL,'https://ci.example.test');
  } finally {await rm(directory,{recursive:true,force:true});}
});
