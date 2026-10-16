import {spawn,execFile} from 'node:child_process';
import {createCipheriv,createDecipheriv,createHash,randomBytes} from 'node:crypto';
import {createReadStream,createWriteStream} from 'node:fs';
import {chmod,mkdir,mkdtemp,open,readFile,rm,stat,writeFile} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {pipeline} from 'node:stream/promises';
import {Readable} from 'node:stream';
import {promisify,isDeepStrictEqual} from 'node:util';
import {fileURLToPath} from 'node:url';
const exec=promisify(execFile);
const FILES=['database.dump','workspace.tgz','memory.tgz','configuration.env','inventory.json'];
const writers=['gateway','web','web2','worker','mnemosyne'];
const key=()=>{
  const value=process.env.BACKUP_ENCRYPTION_KEY||'';
  if(!/^[a-f0-9]{64}$/i.test(value))throw new Error('Set BACKUP_ENCRYPTION_KEY to a separate 64-hex encryption key.');
  return Buffer.from(value,'hex');
};
const digest=async file=>{const h=createHash('sha256');for await(const chunk of createReadStream(file))h.update(chunk);return h.digest('hex');};
function command(args,input) {
  const child=spawn('docker',args,{stdio:['pipe','pipe','pipe']});
  let stderr='';child.stderr.on('data',c=>{stderr=(stderr+c).slice(-4000);});
  const done=new Promise((resolveDone,reject)=>{child.once('error',reject);child.once('close',code=>code===0?resolveDone():reject(new Error(stderr||`Docker command failed (${code}).`)));});
  done.catch(()=>{});
  child.stdin.on('error',()=>{});
  if(input){input.on('error',()=>child.kill('SIGKILL'));input.pipe(child.stdin);}else child.stdin.end();
  return {stream:child.stdout,done,stop:()=>child.kill('SIGKILL')};
}
async function capture(args) {
  const result=await exec('docker',args,{maxBuffer:32*1024*1024});return result.stdout.trim();
}
async function encrypt(source,file,name) {
  const iv=randomBytes(12),cipher=createCipheriv('aes-256-gcm',key(),iv);cipher.setAAD(Buffer.from(name));
  await writeFile(file,iv,{mode:0o600,flag:'wx'});
  await pipeline(source,cipher,createWriteStream(file,{flags:'a',mode:0o600}));
  const handle=await open(file,'a');try{await handle.write(cipher.getAuthTag());await handle.sync();}finally{await handle.close();}
  return {bytes:(await stat(file)).size,sha256:await digest(file)};
}
async function decrypt(file,destination,name,expected) {
  if((await stat(file)).size!==expected.bytes||await digest(file)!==expected.sha256)throw new Error(`Backup checksum mismatch: ${name}`);
  const handle=await open(file,'r'),size=expected.bytes;
  if(size<28)throw new Error('Invalid encrypted backup.');
  const iv=Buffer.alloc(12),tag=Buffer.alloc(16);
  try{await handle.read(iv,0,12,0);await handle.read(tag,0,16,size-16);}finally{await handle.close();}
  const cipher=createDecipheriv('aes-256-gcm',key(),iv);cipher.setAAD(Buffer.from(name));cipher.setAuthTag(tag);
  await pipeline(createReadStream(file,{start:12,end:size-17}),cipher,createWriteStream(destination,{flags:'wx',mode:0o600}));
}
async function configuration(options) {
  const args=['compose','--env-file',resolve(options.envFile),'-f',resolve(options.composeFile)];
  if(options.project)args.push('-p',options.project);
  // Parse privately: never print resolved Compose configuration (contains secrets).
  const config=JSON.parse(await capture([...args,'config','--format','json']));
  const env=config.services.web.environment;
  if(env.STORAGE_PROVIDER!=='local')throw new Error('This backup profile requires local storage.');
  if(env.STORAGE_LOCAL_DIR&&env.STORAGE_LOCAL_DIR!==`${env.MULTIPLAYER_AI_DATA}/objects`)throw new Error('External object directories need their own coordinated backup profile.');
  const workspace=config.services.web.volumes.find(v=>v.type==='volume'&&v.target===env.MULTIPLAYER_AI_DATA);
  const memory=config.services.mnemosyne.volumes.find(v=>v.type==='volume'&&v.target==='/data');
  if(!workspace||!memory)throw new Error('Expected named workspace and memory volumes.');
  const volume=name=>config.volumes[name]?.name;
  if(!volume(workspace.source)||!volume(memory.source))throw new Error('Unresolved backup volume names.');
  return {args,config,workspace:volume(workspace.source),memory:volume(memory.source),image:config.services.postgres.image};
}
function tarArgs(profile,volume,extract=false) {
  return ['run','--rm',...(extract?['-i']:[]),'--network','none','--mount',`type=volume,source=${volume},target=/data${extract?'':',readonly'}`,
    '--entrypoint','tar',profile.image,...(extract?['-xzf','-','--no-same-owner','-C','/data']:['-czf','-','-C','/data','.'])];
}
async function inventory(profile) {
  const script=fileURLToPath(new URL('./verify-restored-state.mjs',import.meta.url));
  return JSON.parse(await capture([...profile.args,'run','--rm','--no-deps','-T','-v',`${script}:/app/scripts/verify-restored-state.mjs:ro`,
    '--entrypoint','node','web','/app/scripts/verify-restored-state.mjs']));
}

export async function createBackup(options) {
  key();const profile=await configuration(options),destination=resolve(options.destination);
  // Never overwrite an earlier backup. Every successful backup has a manifest;
  // partial output is kept for diagnosis and must not be treated as restorable.
  await mkdir(destination,{mode:0o700});await chmod(destination,0o700);
  const running=(await capture([...profile.args,'ps','--status','running','--services'])).split('\n');
  const stopped=writers.filter(name=>running.includes(name));
  const stoppedContainers=stopped.length?(await capture([...profile.args,'ps','--status','running','--quiet',...stopped])).split('\n').filter(Boolean):[];
  const manifest={version:1,createdAt:new Date().toISOString(),project:profile.config.name,files:{}};
  const save=async(name,source)=>{manifest.files[name]=await encrypt(source,join(destination,name+'.enc'),name);};
  const saveCommand=async(name,args)=>{
    const child=command(args);
    try{await save(name,child.stream);await child.done;}catch(error){child.stop();await child.done.catch(()=>{});throw error;}
  };
  try {
    if(stopped.length)await capture([...profile.args,'stop','--timeout','90',...stopped]);
    if((await capture([...profile.args,'ps','--status','running','--services'])).split('\n').some(name=>writers.includes(name)))throw new Error('A writer is still running; backup refused.');
    const before=await inventory(profile);
    await save('inventory.json',Readable.from([JSON.stringify(before)]));
    await saveCommand('database.dump',[...profile.args,'exec','-T','postgres','sh','-c','exec pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" --format=custom --no-owner --no-acl']);
    await saveCommand('workspace.tgz',tarArgs(profile,profile.workspace));
    await saveCommand('memory.tgz',tarArgs(profile,profile.memory));
    await save('configuration.env',Readable.from([await readFile(options.envFile)]));
    // Detect an unexpected writer outside the stopped application services.
    if(!isDeepStrictEqual(before,await inventory(profile)))throw new Error('State changed during backup; archive was not committed.');
    await writeFile(join(destination,'manifest.json'),JSON.stringify(manifest,null,2)+'\n',{mode:0o600,flag:'wx'});
    console.log('Encrypted coordinated backup verified. Copy it and the separately held encryption key off this host.');
    return manifest;
  } finally {
    // Resume the exact containers we paused. Compose start resolves depends_on
    // again and fails when a successful `run --rm migrate` no longer exists.
    // Docker start preserves the original image/config and never reruns setup.
    if(stoppedContainers.length)await capture(['start',...stoppedContainers]);
  }
}

/** Recover secrets to an explicitly named, new private file after host loss. */
export async function restoreConfiguration(options) {
  key();
  const source=resolve(options.source),manifest=JSON.parse(await readFile(join(source,'manifest.json'),'utf8'));
  if(manifest.version!==1||!manifest.files?.['configuration.env'])throw new Error('Unsupported backup manifest.');
  const scratch=await mkdtemp(join(tmpdir(),'mp-restore-config-'));await chmod(scratch,0o700);
  try {
    const file=join(scratch,'configuration.env');
    await decrypt(join(source,'configuration.env.enc'),file,'configuration.env',manifest.files['configuration.env']);
    await writeFile(resolve(options.destination),await readFile(file),{mode:0o600,flag:'wx'});
    console.log('Original configuration recovered to the requested private file. Secret values were not printed.');
  } finally {await rm(scratch,{recursive:true,force:true});}
}

export async function restoreBackup(options) {
  key();
  if(!options.project)throw new Error('Restore requires an explicit new --project name.');
  const source=resolve(options.source),manifest=JSON.parse(await readFile(join(source,'manifest.json'),'utf8'));
  if(manifest.version!==1||!isDeepStrictEqual(Object.keys(manifest.files).sort(),[...FILES].sort()))throw new Error('Unsupported or incomplete backup manifest.');
  const scratch=await mkdtemp(join(tmpdir(),'mp-restore-'));await chmod(scratch,0o700);
  try {
    // Authenticate every artifact before creating or touching any target state.
    for(const name of FILES)await decrypt(join(source,name+'.enc'),join(scratch,name),name,manifest.files[name]);
    const profile=await configuration(options);
    const original=await configuration({...options,envFile:join(scratch,'configuration.env')});
    const sourceKey=original.config.services.web.environment.INTEGRATIONS_ENCRYPTION_KEY;
    if(sourceKey&&sourceKey!==profile.config.services.web.environment.INTEGRATIONS_ENCRYPTION_KEY)throw new Error('Restore requires the original INTEGRATIONS_ENCRYPTION_KEY. Recover the encrypted configuration first.');
    if(profile.config.name===manifest.project)throw new Error('Restore must use a different, empty Compose project.');
    if(await capture([...profile.args,'ps','--all','--quiet']))throw new Error('Restore target already has containers. Use a new project.');
    for(const name of [profile.workspace,profile.memory]) {
      if(await capture(['volume','ls','--filter',`name=^${name}$`,'--format','{{.Name}}']))throw new Error('Restore target volume already exists; refusing to overwrite data.');
    }
    // Check every named volume, including PostgreSQL, for accidental aliasing.
    for(const volume of Object.values(profile.config.volumes))if(volume.external||await capture(['volume','ls','--filter',`name=^${volume.name}$`,'--format','{{.Name}}']))throw new Error('Restore requires entirely new, non-external volumes.');
    await capture([...profile.args,'up','-d','--wait','--no-deps','postgres','redis']);
    for(const volume of [profile.workspace,profile.memory])await capture(['volume','create',volume]);
    const restored=command([...profile.args,'exec','-T','postgres','sh','-c','exec pg_restore -U "$POSTGRES_USER" -d "$POSTGRES_DB" --no-owner --no-acl --exit-on-error'],createReadStream(join(scratch,'database.dump')));
    restored.stream.resume();await restored.done;
    for(const [name,volume] of [['workspace.tgz',profile.workspace],['memory.tgz',profile.memory]]) {
      const child=command(tarArgs(profile,volume,true),createReadStream(join(scratch,name)));child.stream.resume();await child.done;
    }
    const expected=JSON.parse(await readFile(join(scratch,'inventory.json'),'utf8'));
    if(!isDeepStrictEqual(expected,await inventory(profile)))throw new Error('Restored database, Git refs, checkpoints or objects differ from the source. Application remains stopped.');
    const result={verifiedAt:new Date().toISOString(),backupCreatedAt:manifest.createdAt,sourceProject:manifest.project,targetProject:profile.config.name,tables:Object.keys(expected.database).length,repositories:Object.keys(expected.refs).length,activityBatches:expected.activity};
    if(options.report)await writeFile(resolve(options.report),JSON.stringify(result,null,2)+'\n',{mode:0o600,flag:'wx'});
    console.log('Restore verified. Web, worker and gateway remain stopped. Restore integration encryption keys from the original secure configuration before starting services.');
    return result;
  } finally {await rm(scratch,{recursive:true,force:true});}
}

if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  const [action,...argv]=process.argv.slice(2),options={composeFile:'compose.production.yml',envFile:'.env.production'};
  const names={'--compose':'composeFile','--env-file':'envFile','--output':'destination','--source':'source','--project':'project','--report':'report'};
  try{
    for(let i=0;i<argv.length;i+=2){if(!names[argv[i]]||!argv[i+1])throw new Error('Invalid backup arguments.');options[names[argv[i]]]=argv[i+1];}
    if(action==='create'&&options.destination)await createBackup(options);
    else if(action==='restore-config'&&options.source&&options.destination)await restoreConfiguration(options);
    else if(action==='restore'&&options.source)await restoreBackup(options);
    else throw new Error('Use create --output NEW_DIRECTORY, or restore --source BACKUP_DIRECTORY --project NEW_NAME [--report NEW_FILE].');
  }catch(error){console.error(error.message);process.exitCode=1;}
}
