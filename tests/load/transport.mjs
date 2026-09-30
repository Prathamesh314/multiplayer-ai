import { Agent } from 'undici';

export function connectionShards(connections) {
  const count=Math.ceil(connections/64);
  return Array.from({length:count},(_,index)=>Math.floor(connections/count)+(index<connections%count?1:0));
}

// Undici scans a pool's clients on dispatch. Small shards keep that overhead
// bounded while preserving the configured total connection limit.
export function dispatchers(connections) {
  const agents=connectionShards(connections).map(size=>new Agent({connections:size,keepAliveTimeoutThreshold:3000}));
  return {forUser:index=>agents[index%agents.length],destroy:()=>Promise.all(agents.map(agent=>agent.destroy()))};
}
