import {build} from 'esbuild';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {mkdir,readFile,writeFile,chmod,copyFile,rename} from 'node:fs/promises';
import {dirname,join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const target=join(root,'.runner-build','package');
const downloads=join(root,'public','downloads');
const manifest=JSON.parse(await readFile(join(root,'package.json'),'utf8'));
const npmCli=process.env.npm_execpath;
if(!npmCli)throw new Error('Run this builder with npm run runner:pack.');
await mkdir(target,{recursive:true});
await mkdir(downloads,{recursive:true});
const result=await build({entryPoints:[join(root,'runner','index.ts')],outfile:join(target,'runner.cjs'),
  bundle:true,platform:'node',format:'cjs',target:'node22',metafile:true,sourcemap:false,legalComments:'eof',
  banner:{js:'#!/usr/bin/env node'},define:{'process.env.MULTIPLAYER_RUNNER_VERSION':JSON.stringify(manifest.version)}});
// Keep this distribution dependency-free. Fail closed if future runner imports
// pull in npm packages (which would require their runtime files and notices).
if(Object.keys(result.metafile.inputs).some(input=>input.includes('node_modules/'))) {
  throw new Error('The runner bundle now includes third-party packages; review distribution dependencies and licenses.');
}
await chmod(join(target,'runner.cjs'),0o755);
await writeFile(join(target,'package.json'),JSON.stringify({name:'multiplayer-ai-runner',version:manifest.version,
  description:'Connect your computer to a Multiplayer AI workspace',private:true,license:'UNLICENSED',
  bin:{'multiplayer-ai-runner':'runner.cjs'},engines:{node:'>=22'},files:['runner.cjs','README.md']},null,2)+'\n');
await copyFile(join(root,'runner','README.md'),join(target,'README.md'));
const {stdout}=await promisify(execFile)(process.execPath,[npmCli,'pack','--json','--ignore-scripts','--pack-destination',join(root,'.runner-build')],
  {cwd:target,env:{...process.env,npm_config_cache:join(root,'.runner-build','npm-cache')},maxBuffer:1024*1024});
const [packed]=JSON.parse(stdout);
const artifact=join(downloads,'multiplayer-ai-runner.tgz');
await copyFile(join(root,'.runner-build',packed.filename),artifact+'.tmp');
await rename(artifact+'.tmp',artifact);
await writeFile(join(root,'.runner-build','bundle-inputs.json'),JSON.stringify(Object.keys(result.metafile.inputs),null,2));
console.log(`Built standalone runner ${manifest.version}: ${artifact} (${packed.size} bytes)`);
