import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { Worker } from "node:worker_threads";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { resolve } from "node:path";
import { Pool, type PoolClient, type QueryResultRow } from "pg";
import type { FileEntry, Job } from "./compute";

const key = process.env.BENCHMARK_KEY;
if (!key || !/^load_test_[a-f0-9]{32}$/.test(process.env.BENCHMARK_SCHEMA ?? "")) throw new Error("Only isolated benchmark fixtures are allowed");
const sql: Record<string,string> = JSON.parse(readFileSync(process.env.BENCHMARK_SQL!,"utf8"));
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: Number(process.env.DB_POOL ?? 10), connectionTimeoutMillis: 5000,
  statement_timeout: 5000, options: `-c search_path=${process.env.BENCHMARK_SCHEMA},public` });
pool.on("error", () => { errors++; });
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const roomPattern = /^[a-z2-9]{12}$/;
let errors = 0, dropped = 0, openStreams = 0, stopping = false;
class Failure extends Error { constructor(public status: number) { super(String(status)); } }
type Work = { job: Job; resolve: (value: unknown) => void; reject: (error: unknown) => void };
const waiting: Work[] = [];
const workers = Array.from({ length: Number(process.env.COMPUTE_WORKERS ?? 4) }, () => {
  const slot: { worker: Worker; task?: Work } = { worker: new Worker(resolve(process.env.BENCHMARK_WORKER!)) };
  slot.worker.on("message", value => { const task = slot.task; slot.task = undefined; task?.resolve(value); dispatch(); });
  slot.worker.on("error", error => { slot.task?.reject(error); process.exitCode = 1; void shutdown(); });
  return slot;
});
function dispatch() { for (const slot of workers) if (!slot.task && waiting.length) { slot.task = waiting.shift()!; slot.worker.postMessage(slot.task.job); } }
function run(job: Job) { return new Promise((resolve,reject) => {
  if (waiting.length >= 256) return reject(new Failure(503));
  waiting.push({job,resolve,reject}); dispatch();
}); }
const streams = new Map<string,Set<ServerResponse>>();
async function body(request: IncomingMessage): Promise<Record<string,unknown>> {
  const chunks: Buffer[] = []; let bytes = 0;
  for await (const chunk of request) { bytes += chunk.length; if (bytes <= 2*1024*1024) chunks.push(chunk); }
  if (bytes > 2*1024*1024) throw new Failure(413);
  try { const result = JSON.parse(Buffer.concat(chunks).toString()); if (!result || Array.isArray(result) || typeof result !== "object") throw new Error(); return result; }
  catch { throw new Failure(400); }
}
function files(value: unknown): value is FileEntry[] {
  if (!Array.isArray(value) || value.length > 20000) return false;
  const paths = new Set();
  return value.every(file => {
    if (!file || typeof file.path !== "string" || !/^[a-zA-Z0-9_./-]{1,200}$/.test(file.path) || paths.has(file.path) ||
      typeof file.sha !== "string" || !/^[a-f0-9]{16}$/.test(file.sha) || !Number.isSafeInteger(file.size) || file.size < 0 || file.size > 1000000000) return false;
    paths.add(file.path); return true;
  });
}
const server = createServer(async (request,response) => {
  const started = performance.now(); let client: PoolClient | undefined, poolMs = 0, dbMs = 0;
  async function query<T extends QueryResultRow>(name: string, values: unknown[] = []) {
    if (!client) { const at = performance.now(); client = await pool.connect(); poolMs += performance.now()-at; }
    const at = performance.now(); try { return (await client.query<T>(sql[name],values)).rows; } finally { dbMs += performance.now()-at; }
  }
  function send(status: number, value: unknown, raw = false) {
    if (response.destroyed) return;
    response.writeHead(status,{"content-type":"application/json","cache-control":"no-store",
      "server-timing":`pool;dur=${poolMs.toFixed(3)},db;dur=${dbMs.toFixed(3)},total;dur=${(performance.now()-started).toFixed(3)}`});
    response.end(raw ? value as string : JSON.stringify(value));
  }
  try {
    if (stopping) throw new Failure(503);
    if (request.headers["x-benchmark-key"] !== key) throw new Failure(401);
    const url = new URL(request.url!,"http://localhost"), method = request.method;
    if (method === "GET" && url.pathname === "/health") return send(200,{ok:true});
    if (method === "GET" && url.pathname === "/stats") {
      const usage = process.resourceUsage();
      return send(200,{cpuUserMicros:usage.userCPUTime,cpuSystemMicros:usage.systemCPUTime,rss:process.memoryUsage().rss,openStreams,dropped,errors,queued:waiting.length});
    }
    if (method === "POST" && (url.pathname === "/graph" || url.pathname === "/snapshot")) {
      const input = await body(request); let job: Job;
      if (url.pathname === "/graph") {
        const {nodes,rounds,seed} = input;
        if (![nodes,rounds,seed].every(Number.isSafeInteger) || Number(nodes)<16 || Number(nodes)>25000 || Number(rounds)<1 || Number(rounds)>64 || Number(seed)<0 || Number(seed)>1000000) throw new Failure(400);
        job = {kind:"graph",nodes:Number(nodes),rounds:Number(rounds),seed:Number(seed)};
      } else { if (!files(input.base) || !files(input.head)) throw new Failure(400); job = {kind:"snapshot",base:input.base,head:input.head}; }
      return send(200,await run(job));
    }
    if (method === "GET" && url.pathname === "/git") {
      const {stdout} = await promisify(execFile)("git",["-c","core.hooksPath=/dev/null","diff","--no-ext-diff","--no-textconv","--numstat",process.env.GIT_BASE!,process.env.GIT_HEAD!],
        {cwd:process.env.BENCHMARK_REPO,encoding:"buffer",maxBuffer:2*1024*1024,timeout:10000,env:{...process.env,GIT_CONFIG_NOSYSTEM:"1",GIT_CONFIG_GLOBAL:"/dev/null",GIT_NO_REPLACE_OBJECTS:"1"}});
      return send(200,{bytes:stdout.length,sha256:createHash("sha256").update(stdout).digest("hex")});
    }
    const token = request.headers.authorization?.replace(/^Bearer /,"") ?? "";
    const user = (await query<{id:string}>("auth",[createHash("sha256").update(token).digest("hex")]))[0]?.id;
    if (!user) throw new Failure(401);
    if (method === "GET" && url.pathname === "/hold") { await query("hold"); return send(200,{ok:true}); }
    const match = /^\/rooms\/([a-z2-9]{12})\/(tasks|roster|events)$/.exec(url.pathname);
    if (match) {
      const [,room,operation] = match;
      const role = (await query<{role:string}>("gate",[room,user]))[0]?.role;
      if (!role) throw new Failure(403);
      if (method === "GET" && operation !== "events") return send(200,(await query<{body:string}>(operation,[room,user]))[0].body,true);
      if (method === "GET" && operation === "events") {
        client!.release(); client = undefined;
        response.writeHead(200,{"content-type":"text/event-stream","cache-control":"no-store","connection":"keep-alive"});
        if (!streams.has(room)) streams.set(room,new Set()); streams.get(room)!.add(response); openStreams++;
        response.write(`data: ${JSON.stringify({ready:room})}\n\n`);
        const heartbeat = setInterval(() => response.write(": keepalive\n\n"),25000); heartbeat.unref();
        response.on("close",() => { clearInterval(heartbeat); streams.get(room)?.delete(response); if (!streams.get(room)?.size) streams.delete(room); openStreams--; });
        return;
      }
      if (method === "POST" && operation === "events") {
        if (!["owner","editor"].includes(role)) throw new Failure(403);
        const input = await body(request);
        if (typeof input.id !== "string" || input.id.length>100 || typeof input.body !== "string" || Buffer.byteLength(input.body)>4096 || !Number.isSafeInteger(input.at) || Number(input.at)<0) throw new Failure(400);
        const frame = `data: ${JSON.stringify({id:input.id,body:input.body,at:input.at,room})}\n\n`;
        for (const stream of streams.get(room) ?? []) {
          if (stream.writableLength+Buffer.byteLength(frame)>65536) { dropped++; stream.destroy(); } else stream.write(frame);
        }
        return send(200,{ok:true});
      }
      throw new Failure(405);
    }
    if (method === "POST" && url.pathname === "/tasks") {
      const input = await body(request);
      const {id,runId,room,assigneeId} = input;
      if (![id,runId,assigneeId].every(value => typeof value === "string" && uuid.test(value)) || typeof room !== "string" || !roomPattern.test(room) || typeof input.body !== "string" || !input.body.trim() || [...input.body.trim()].length>4000) throw new Failure(400);
      const values = [id,runId,user,assigneeId,input.body.trim()];
      await query("begin");
      try {
        if (!(await query("allow",[runId,room,user,assigneeId])).length) throw new Failure(403);
        await query("insert",values);
        if (!(await query("existing",values)).length) throw new Failure(409);
        await query("commit");
      } catch (error) { await query("rollback"); throw error; }
      return send(201,{id});
    }
    const task = /^\/tasks\/([a-f0-9-]{36})$/.exec(url.pathname);
    if (method === "PATCH" && task && uuid.test(task[1])) {
      if (!(await query("complete",[task[1],user])).length) throw new Failure(403);
      return send(200,{ok:true});
    }
    throw new Failure(404);
  } catch (error) {
    const status = error instanceof Failure ? error.status : 500;
    if (status === 500) { errors++; console.error(error instanceof Error ? error.message : "request failed"); }
    send(status,{error:status});
  } finally { client?.release(); }
});
server.keepAliveTimeout = 70000; server.requestTimeout = 15000;
server.listen(Number(process.env.PORT ?? 0),"127.0.0.1",() => console.log(JSON.stringify({port:(server.address() as {port:number}).port})));
async function shutdown() {
  if (stopping) return; stopping = true;
  for (const group of streams.values()) for (const response of group) response.end();
  waiting.splice(0).forEach(task => task.reject(new Failure(503)));
  server.close(); server.closeIdleConnections();
  await Promise.all(workers.map(slot => { slot.task?.reject(new Failure(503)); slot.task = undefined; return slot.worker.terminate(); })); await pool.end();
}
process.on("SIGTERM",() => { void shutdown(); }); process.on("SIGINT",() => { void shutdown(); });
