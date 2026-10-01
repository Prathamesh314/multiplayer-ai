import { createHash } from "node:crypto";
import { createClient } from "redis";

export type LimitPolicy = { name: string; perMinute: number; burst: number };
export type LimitResult = { allowed: boolean; remaining: number; retryAfter: number; resetAfter: number };
export interface LimitStore {
  take(key: string, policy: LimitPolicy): Promise<LimitResult>;
  ready(): Promise<void>;
}

// Redis owns the clock and the read/refill/debit/expiry operation. Two web
// instances cannot each spend the same token. Rejected requests do not extend
// the penalty; every key expires once its bucket would be completely refilled.
export const TOKEN_BUCKET_SCRIPT = `
local clock = redis.call('TIME')
local now = tonumber(clock[1]) * 1000 + tonumber(clock[2]) / 1000
local capacity = tonumber(ARGV[1])
local rate = tonumber(ARGV[2]) / 60000
local previous = redis.call('HMGET', KEYS[1], 'tokens', 'at')
local tokens = math.min(capacity, tonumber(previous[1]) or capacity)
local at = tonumber(previous[2]) or now
tokens = math.min(capacity, tokens + math.max(0, now - at) * rate)
local allowed = 0
if tokens >= 1 then tokens = tokens - 1; allowed = 1 end
local retry = allowed == 1 and 0 or math.ceil((1 - tokens) / rate / 1000)
local reset = math.ceil((capacity - tokens) / rate / 1000)
redis.call('HSET', KEYS[1], 'tokens', tokens, 'at', now)
redis.call('PEXPIRE', KEYS[1], math.max(1, math.ceil((capacity - tokens) / rate)))
return {allowed, math.floor(tokens), retry, reset}
`;

export function limitKey(namespace: string, identity: string, policy: LimitPolicy) {
  // Never put cookies, bearer tokens or IP addresses in Redis keys/logs.
  return `${namespace}:${policy.name}:${createHash("sha256").update(identity).digest("hex")}`;
}

export class MemoryLimitStore implements LimitStore {
  private buckets = new Map<string, { tokens: number; at: number; expires: number }>();
  constructor(private clock = Date.now, private maxEntries = 10_000) {}
  async ready() {}
  async take(key: string, policy: LimitPolicy): Promise<LimitResult> {
    const now = this.clock();
    if (this.buckets.size >= this.maxEntries) {
      for (const [id, bucket] of this.buckets) if (bucket.expires <= now) this.buckets.delete(id);
    }
    if (!this.buckets.has(key) && this.buckets.size >= this.maxEntries) throw new Error("Rate limiter capacity reached");
    const previous = this.buckets.get(key);
    const rate = policy.perMinute / 60_000;
    let tokens = Math.min(policy.burst, (previous?.tokens ?? policy.burst) + Math.max(0, now - (previous?.at ?? now)) * rate);
    const allowed = tokens >= 1;
    if (allowed) tokens--;
    const refillMs = (policy.burst - tokens) / rate;
    this.buckets.set(key, { tokens, at: now, expires: now + refillMs });
    return { allowed, remaining: Math.floor(tokens), retryAfter: allowed ? 0 : Math.ceil((1 - tokens) / rate / 1000), resetAfter: Math.ceil(refillMs / 1000) };
  }
}

export function redisLimitStore(url: string) {
  const client = createClient({ url, disableOfflineQueue: true, commandsQueueMaxLength: 1000,
    socket: { connectTimeout: 1000, reconnectStrategy: retries => Math.min(1000, 100 + retries * 100) } });
  // Do not log connection strings/credentials on errors. Requests fail closed
  // with a bounded 503 while this client reconnects in the background.
  client.on("error", () => {});
  const connecting = client.connect().catch(() => {});
  // The first request may create the client. Give a healthy Redis one bounded
  // handshake instead of rejecting that first request merely for being first.
  // Later disconnects still fail immediately while background recovery runs.
  const initialConnection = new Promise<void>(resolve => {
    const timer = setTimeout(resolve, 1000);
    void connecting.then(() => { clearTimeout(timer); resolve(); });
  });
  const connected = async () => {
    if (!client.isReady) await initialConnection;
    if (!client.isReady) throw new Error("Rate limiter unavailable");
  };
  const store: LimitStore = {
    async ready() {
      await connected();
      await client.withAbortSignal(AbortSignal.timeout(1000)).ping();
    },
    async take(key, policy) {
      await connected();
      const result = await client.withAbortSignal(AbortSignal.timeout(1000)).eval(TOKEN_BUCKET_SCRIPT, {
        keys: [key], arguments: [String(policy.burst), String(policy.perMinute)],
      }) as number[];
      return { allowed: result[0] === 1, remaining: result[1], retryAfter: result[2], resetAfter: result[3] };
    },
  };
  return { store, close: () => { if (client.isOpen) client.destroy(); } };
}

const state = globalThis as unknown as { __maLimits?: LimitStore };
export function limitStore(): LimitStore {
  if (!state.__maLimits) {
    if (process.env.REDIS_URL) state.__maLimits = redisLimitStore(process.env.REDIS_URL).store;
    else if (process.env.LOCAL_RUNNERS === "1" || Number(process.env.WEB_CONCURRENCY ?? 1) > 1) {
      throw new Error("Hosted rate limiting requires Redis");
    } else state.__maLimits = new MemoryLimitStore();
  }
  return state.__maLimits;
}
