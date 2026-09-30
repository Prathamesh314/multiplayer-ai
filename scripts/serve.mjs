import cluster from 'node:cluster';
import { createRequire } from 'node:module';
import nextEnv from '@next/env';
import { serverWorkers } from './server-config.mjs';

process.env.NODE_ENV ??= 'production';
nextEnv.loadEnvConfig(process.cwd());
const count = serverWorkers();
const require = createRequire(import.meta.url);
const entry = require.resolve('next/dist/bin/next');
const args = ['start', '--keepAliveTimeout', '70000', ...process.argv.slice(2)];

if (count === 1) {
  // Preserve the ordinary Next CLI lifecycle for local/desktop installations.
  process.argv = [process.execPath, entry, ...args];
  require(entry);
} else {
  cluster.schedulingPolicy = cluster.SCHED_RR;
  cluster.setupPrimary({ exec: entry, args });
  let stopping = false;
  let exitCode = 0;
  let deadline;
  const restarts = new Set();
  const crashes = [];
  const live = () => Object.values(cluster.workers).filter(Boolean);
  function finish() {
    if (stopping && !live().length) {
      clearTimeout(deadline);
      process.exit(exitCode);
    }
  }
  function stop(code = 0) {
    if (stopping) return;
    stopping = true;
    exitCode = code;
    for (const timer of restarts) clearTimeout(timer);
    for (const worker of live()) worker.process.kill('SIGTERM');
    deadline = setTimeout(() => {
      for (const worker of live()) worker.process.kill('SIGKILL');
    }, 30000);
    finish();
  }
  process.on('SIGINT', () => stop());
  process.on('SIGTERM', () => stop());
  cluster.on('exit', (worker, code, signal) => {
    if (stopping) return finish();
    console.error(`Web process ${worker.process.pid} exited (${signal ?? code}).`);
    const now = Date.now();
    crashes.push(now);
    while (crashes[0] < now - 60000) crashes.shift();
    if (crashes.length >= count * 3) return stop(1);
    const timer = setTimeout(() => {
      restarts.delete(timer);
      if (!stopping) cluster.fork();
    }, 1000);
    restarts.add(timer);
  });
  for (let index = 0; index < count; index++) cluster.fork();
}
