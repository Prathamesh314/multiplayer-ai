import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

export function processTreeRss(output, root) {
  const processes = output.trim().split('\n').map(line => line.trim().split(/\s+/).map(Number));
  const owned = new Set([root]);
  for (let size = -1; size !== owned.size;) {
    size = owned.size;
    for (const [pid, parent] of processes) if (owned.has(parent)) owned.add(pid);
  }
  return processes.reduce((sum, [pid, , memory]) => sum + (owned.has(pid) ? memory * 1024 : 0), 0);
}

// The generator can exceed macOS's posix_spawn FD limit. Sample from a small
// separate process so high-load measurements do not silently stop at that point.
if (process.send) {
  let busy = false;
  const sample = async () => {
    if (busy) return;
    busy = true;
    try {
      const { stdout } = await promisify(execFile)('ps', ['-axo', 'pid=,ppid=,rss='], { timeout: 2000 });
      if (process.connected) process.send({ rss: processTreeRss(stdout, Number(process.argv[2])) });
    } catch { if (process.connected) process.send({ unavailable: true }); }
    finally { busy = false; }
  };
  const timer = setInterval(() => void sample(), 2000);
  void sample();
  process.on('disconnect', () => { clearInterval(timer); process.exit(0); });
}
