export type FileEntry = { path: string; sha: string; size: number };
export type Job = { kind: "graph"; nodes: number; rounds: number; seed: number } |
  { kind: "snapshot"; base: FileEntry[]; head: FileEntry[] };

export function compute(job: Job) {
  if (job.kind === "graph") {
    const { nodes, rounds, seed } = job;
    const seen = new Uint32Array(nodes), queue = new Uint32Array(nodes);
    let checksum = 2166136261 >>> 0, visited = 0;
    for (let round = 1; round <= rounds; round++) {
      let start = 0, end = 1;
      queue[0] = (seed + round) % nodes; seen[queue[0]] = round;
      while (start < end) {
        const node = queue[start++]; visited++;
        checksum = Math.imul(checksum ^ node, 16777619) >>> 0;
        for (let edge = 0; edge < 8; edge++) {
          const next = ((Math.imul(node + 1, 1664525) + Math.imul(edge + seed, 1013904223)) >>> 0) % nodes;
          if (seen[next] !== round) { seen[next] = round; queue[end++] = next; }
        }
      }
    }
    return { checksum, visited };
  }
  const old = new Map(job.base.map(file => [file.path,file]));
  let added = 0, modified = 0, deleted = 0, bytes = 0, checksum = 2166136261 >>> 0;
  const changed: string[] = [];
  for (const file of job.head) {
    const previous = old.get(file.path); old.delete(file.path);
    if (!previous) added++;
    else if (previous.sha !== file.sha || previous.size !== file.size) modified++;
    else continue;
    bytes += file.size; changed.push(file.path);
  }
  for (const path of old.keys()) { deleted++; changed.push(path); }
  changed.sort();
  for (const path of changed) for (let i = 0; i < path.length; i++) checksum = Math.imul(checksum ^ path.charCodeAt(i),16777619) >>> 0;
  return { added,modified,deleted,bytes,checksum };
}
