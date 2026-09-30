export function options(args) {
  const values = {};
  for (let index = 0; index < args.length; index++) {
    const [key, inline] = args[index].replace(/^--/, '').split('=');
    if (!args[index].startsWith('--')) throw new Error(`Expected --option, received ${args[index]}`);
    values[key] = inline ?? args[++index];
    if (values[key] === undefined || values[key].startsWith('--')) throw new Error(`Missing value for --${key}`);
  }
  const profiles = { smoke: { users: 10, duration: 20, ramp: 3 }, '100': { users: 100, duration: 60, ramp: 20 }, '1000': { users: 1000, duration: 120, ramp: 60 } };
  const profile = values.profile ?? 'smoke';
  if (!profiles[profile]) throw new Error('Profile must be smoke, 100, or 1000.');
  const result = { ...profiles[profile], 'room-size': 10, 'poll-ms': 5000, 'write-ms': 30000,
    'timeout-ms': 10000, 'p95-ms': 1500, 'error-rate': 0.01, sse: 1, port: 0, profile };
  const limits = { users: [1,5000], duration: [5,3600], ramp: [0,600], 'room-size': [1,1000],
    'poll-ms': [100,60000], 'write-ms': [1000,600000], 'timeout-ms': [100,60000], 'p95-ms': [1,60000],
    'error-rate': [0,1], sse: [0,1], port: [0,65535] };
  for (const [key,value] of Object.entries(values)) {
    if (key === 'profile') continue;
    if (!limits[key]) throw new Error(`Unknown option --${key}`);
    const number = Number(value), [min,max] = limits[key];
    if (value === undefined || value === '' || !Number.isFinite(number) || number < min || number > max || (key !== 'error-rate' && !Number.isInteger(number))) throw new Error(`Invalid --${key}: expected ${min}–${max}`);
    result[key] = number;
  }
  return result;
}

/** Fixed logarithmic resolution: bounded memory, percentile upper bounds within ~1%. */
export class Histogram {
  bins = new Map(); count = 0; sum = 0; max = 0;
  add(ms) {
    if (!Number.isFinite(ms) || ms < 0) throw new Error('Invalid duration');
    const bin = Math.floor(Math.log1p(ms) * 100);
    this.bins.set(bin,(this.bins.get(bin) ?? 0)+1); this.count++; this.sum+=ms; this.max=Math.max(this.max,ms);
  }
  percentile(fraction) {
    if (!this.count) return null;
    const target=Math.max(1,Math.ceil(this.count*fraction)); let total=0;
    for (const [bin,count] of [...this.bins].sort(([a],[b])=>a-b)) {
      total+=count; if (total>=target) return Math.min(this.max,Math.expm1((bin+1)/100));
    }
    return this.max;
  }
  summary() {
    const round=n=>n===null?null:Math.round(n*100)/100;
    return {count:this.count,meanMs:this.count?round(this.sum/this.count):null,p50Ms:round(this.percentile(.5)),p95Ms:round(this.percentile(.95)),p99Ms:round(this.percentile(.99)),maxMs:round(this.max)};
  }
}

export class Metrics {
  entries=new Map(); failures=[];
  record(phase,operation,ms,ok,status) {
    const key=phase+':'+operation;
    if (!this.entries.has(key)) this.entries.set(key,{phase,operation,latency:new Histogram(),failed:0,statuses:{}});
    const entry=this.entries.get(key); entry.latency.add(ms); if (!ok) entry.failed++;
    entry.statuses[status]=(entry.statuses[status]??0)+1;
    if (!ok && this.failures.length<30) this.failures.push({phase,operation,status});
  }
  summary() { return [...this.entries.values()].map(({latency,...entry})=>({...entry,...latency.summary(),errorRate:entry.failed/latency.count})); }
}

export function failuresFor(report,config) {
  const reasons=[];
  const measured=report.requests.filter(row=>row.phase==='steady');
  if (!measured.length) reasons.push('No steady-state requests completed.');
  const total=report.requests.reduce((sum,row)=>sum+(row.count??0),0);
  const errors=report.requests.reduce((sum,row)=>sum+(row.failed??0),0);
  if (total && errors/total>config['error-rate']) reasons.push('Overall request error rate, including ramp-up, exceeds threshold.');
  for (const row of measured) {
    if (row.errorRate>config['error-rate']) reasons.push(`${row.operation}: error rate ${(100*row.errorRate).toFixed(2)}% exceeds threshold.`);
    if (row.p95Ms>config['p95-ms']) reasons.push(`${row.operation}: p95 ${row.p95Ms} ms exceeds threshold.`);
  }
  if (report.activatedUsers!==config.users) reasons.push(`Only ${report.activatedUsers}/${config.users} users activated.`);
  if (config.sse && (report.streams.peak!==config.users || report.streams.unexpectedDisconnects || report.streams.missingOwnMessages || report.streams.missingRoomDeliveries)) reasons.push('Live connection or message-delivery check failed.');
  if (config.sse && report.streams.deliveryLatency?.p95Ms>config['p95-ms']) reasons.push('Live event-delivery p95 exceeds threshold.');
  if (report.invariants.some(check=>!check.ok)) reasons.push('Persisted-data invariant failed.');
  if (report.interrupted) reasons.push('Run interrupted; results are incomplete.');
  return reasons;
}
