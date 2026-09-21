import { spawn } from "node:child_process";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { gitStorageConfig, repoKey } from "./config";
import { withGitRepositories } from "./service";
import { withRepoLock } from "../session/repo";

/** Spool the RPC response until receive-pack and durable publication succeed.
 * Sending a successful Git ACK before the S3 upload would permit silent loss. */
export async function gitHttpRpc(id: string, bare: string, args: string[], options: {
  stdin?: Readable; gitProtocol?: string|null; prefix?: string; write?: boolean;
}): Promise<ReadableStream<Uint8Array>> {
  const config = gitStorageConfig();
  await mkdir(config.cacheRoot,{recursive:true});
  const output = join(config.cacheRoot,`.rpc-${randomUUID()}`);
  try {
    await withRepoLock(id, () => withGitRepositories([repoKey(id)],!!options.write, async () => {
      if (!await stat(bare).then(s=>s.isDirectory(),()=>false)) throw new Error("Repository is unavailable.");
      const child = spawn("git",args,{env:{...process.env,GIT_NO_REPLACE_OBJECTS:"1",GIT_CONFIG_NOSYSTEM:"1",GIT_CONFIG_GLOBAL:"/dev/null",GIT_TERMINAL_PROMPT:"0",
        ...(options.gitProtocol?{GIT_PROTOCOL:options.gitProtocol}:{})},windowsHide:true});
      let stderr = "";
      child.stderr.on("data",(chunk:Buffer)=>{stderr=(stderr+chunk.toString()).slice(-4000);});
      const done = new Promise<void>((resolve,reject)=>{
        child.on("error",reject);
        child.on("close",code=>code===0?resolve():reject(new Error(`Git transport failed (${code}): ${stderr}`)));
      });
      const timer = setTimeout(()=>child.kill("SIGKILL"),120_000);timer.unref();
      let bytes = 0;
      const limit = new Transform({transform(chunk:Buffer,_encoding,callback){
        bytes+=chunk.length;callback(bytes>512*1024*1024?new Error("Git request exceeds 512 MiB."):null,chunk);
      }});
      try {
        const target = createWriteStream(output,{flags:"wx"});
        if(options.prefix) target.write(options.prefix);
        await Promise.all([pipeline(options.stdin??Readable.from([]),limit,child.stdin),pipeline(child.stdout,target),done]);
      } finally {clearTimeout(timer);child.kill("SIGKILL");}
    }));
    const source=createReadStream(output);
    source.on("close",()=>{void rm(output,{force:true});});
    return Readable.toWeb(source) as ReadableStream<Uint8Array>;
  } catch(cause) {await rm(output,{force:true});throw cause;}
}
