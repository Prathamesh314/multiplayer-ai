import { StorageAdmissionError } from "../storage/admission";
import { createHash, timingSafeEqual } from "node:crypto";
import { isIP } from "node:net";
import { NextRequest } from "next/server";
import { queryOne } from "../db/client";
import { limitKey, limitStore, type LimitPolicy, type LimitStore } from "./rate-limit";

const defaults = {
  ingress: [6000, 1500], anonymous: [120, 40], auth: [20, 10], pair: [10, 5],
  read: [600, 120], write: [180, 60], upload: [120, 60], stream: [60, 20],
  runner: [600, 120], activity: [600, 180], git: [120, 40], webhook: [6000, 1500],
} as const;
export type PolicyName = keyof typeof defaults;

export function policy(name: PolicyName, env = process.env): LimitPolicy {
  const [perMinute, burst] = defaults[name];
  const read = (suffix: string, fallback: number) => {
    const value = Number(env[`API_RATE_${name.toUpperCase()}_${suffix}`] ?? fallback);
    if (!Number.isSafeInteger(value) || value < 1 || value > 1_000_000) throw new Error("Invalid API rate limit configuration");
    return value;
  };
  return { name, perMinute: read("PER_MINUTE", perMinute), burst: read("BURST", burst) };
}

export function usesDeviceToken(route: string) {
  return route.startsWith("/api/git/") || route.startsWith("/api/runner/runs/") ||
    ["/api/runner/claim", "/api/runner/heartbeat", "/api/runner/me", "/api/runner/events"].includes(route);
}

export function policyFor(route: string, method: string): PolicyName {
  if (route === '/api/integrations/slack/events') return 'webhook';
  if (["/api/auth/login", "/api/auth/continue", "/api/auth/register"].includes(route)) return "auth";
  if (["/api/runner/pair", "/api/runner/pairing"].includes(route)) return "pair";
  if (route.startsWith("/api/git/")) return "git";
  if (["GET", "HEAD"].includes(method) && (route.endsWith("/events") || route === "/api/terminal/pty" || route === "/api/terminal")) return "stream";
  if (route.startsWith("/api/runner/runs/") && route.endsWith("/events")) return "activity";
  if (usesDeviceToken(route)) return "runner";
  if (route.endsWith("/seed")) return "upload";
  return ["GET", "HEAD", "OPTIONS"].includes(method) ? "read" : "write";
}

export function clientAddress(request: Request, env = process.env): string | null {
  if (env.API_TRUST_PROXY !== "1") return "direct";
  const expected = env.PROXY_SHARED_SECRET ?? "";
  if (expected.length < 32) throw new Error("Trusted proxy secret is missing");
  const supplied = request.headers.get("x-multiplayer-proxy-secret") ?? "";
  const actualBytes = Buffer.from(supplied), expectedBytes = Buffer.from(expected);
  if (actualBytes.length !== expectedBytes.length || !timingSafeEqual(actualBytes, expectedBytes)) return null;
  const ip = request.headers.get("x-multiplayer-client-ip") ?? "";
  if (!isIP(ip)) return null;
  // Canonicalize equivalent IPv6 spellings; group privacy addresses by /64.
  if (isIP(ip) === 6) {
    const canonical = new URL(`http://[${ip}]/`).hostname.slice(1, -1);
    if (canonical.startsWith("::ffff:")) {
      const parts = canonical.slice(7).split(":").map(part => parseInt(part, 16));
      return `${parts[0] >> 8}.${parts[0] & 255}.${parts[1] >> 8}.${parts[1] & 255}`;
    }
    const [left, right] = canonical.split("::");
    const a = left ? left.split(":") : [], b = right ? right.split(":") : [];
    return [...a, ...Array(8 - a.length - b.length).fill("0"), ...b].slice(0, 4).join(":") + "::/64";
  }
  return ip;
}

/** Resolve the account, not a token-specific bucket: sessions/devices cannot
 * multiply a user's allowance. Route handlers still perform all authorization. */
export async function requestUserId(request: Request, route: string): Promise<string | null> {
  const device = usesDeviceToken(route);
  const authorization = request.headers.get("authorization") ?? "";
  // Use the same parser as route authentication (including duplicate-cookie
  // precedence and percent decoding), without copying or reading the body.
  const token = device ? (authorization.startsWith("Bearer ") ? authorization.slice(7).trim() : "") :
    new NextRequest(request.url, { headers: request.headers }).cookies.get("ma_auth")?.value;
  if (!token || token.length > 512) return null;
  const hash = createHash("sha256").update(token).digest();
  const row = await queryOne<{ user_id: string }>(device
    ? `SELECT d.user_id FROM runner_devices d JOIN users u ON u.id=d.user_id WHERE d.token_hash=$1 AND d.revoked_at IS NULL AND u.deleted_at IS NULL`
    : `SELECT t.user_id FROM auth_tokens t JOIN users u ON u.id=t.user_id WHERE t.token_hash=$1 AND t.revoked_at IS NULL AND t.expires_at>now() AND u.deleted_at IS NULL`, [hash]);
  return row?.user_id ?? null;
}

type Dependencies = { store: () => LimitStore; userId: typeof requestUserId; env: NodeJS.ProcessEnv };
export async function admitApiRequest(request: Request, route: string, dependencies?: Dependencies): Promise<Response | Headers> {
  const env = dependencies?.env ?? process.env;
  const fail = (status: number, error: string, headers?: Headers) => {
    const output = new Headers(headers);
    output.set("cache-control", "no-store");
    if (status === 503) output.set("retry-after", "2");
    return Response.json({ error }, { status, headers: output });
  };
  try {
    const address = clientAddress(request, env);
    if (address === null) return fail(403, "Connect through the configured application gateway.");
    const store = (dependencies?.store ?? limitStore)();
    const namespace = env.API_RATE_NAMESPACE ?? "multiplayer:api-rate:v1";
    const take = async (identity: string, name: PolicyName) => {
      const rule = policy(name, env);
      const result = await store.take(limitKey(namespace, identity, rule), rule);
      const headers = new Headers({ "x-ratelimit-limit": String(rule.burst), "x-ratelimit-remaining": String(result.remaining),
        "x-ratelimit-reset": String(Math.ceil(Date.now() / 1000) + result.resetAfter) });
      if (!result.allowed) {
        headers.set("retry-after", String(Math.max(1, result.retryAfter)));
        return fail(429, "Too many requests. Please wait before trying again.", headers);
      }
      return headers;
    };
    const ingress = await take(`ip:${address}`, "ingress");
    if (ingress instanceof Response) return ingress;
    const name = policyFor(route, request.method);
    // Credential attempts are limited even when a caller also supplies a valid
    // browser cookie. Changing random tokens never creates fresh IP buckets.
    if (name === "auth" || name === 'webhook' || route === "/api/runner/pair") return await take(`ip:${address}`, name);
    const userId = await (dependencies?.userId ?? requestUserId)(request, route);
    return await take(userId ? `user:${userId}` : `ip:${address}`, userId ? name : "anonymous");
  } catch {
    // No per-process fallback when Redis is configured: it would multiply the
    // allowance and bypass protection during outages. Never invoke the handler.
    return fail(503, "Request protection is temporarily unavailable. Please retry shortly.");
  }
}

export function withApiLimit<Args extends unknown[]>(route: string, handler: (request: Request, ...args: Args) => Promise<Response>) {
  return async (request: Request, ...args: Args): Promise<Response> => {
    const admission = await admitApiRequest(request, route);
    if (admission instanceof Response) return admission;
    let response: Response;
    try { response = await handler(request, ...args); }
    catch (cause) {
      if (!(cause instanceof StorageAdmissionError)) throw cause;
      response = Response.json({ error: cause.message }, { status: cause.status });
    }
    const headers = new Headers(response.headers);
    headers.set("cache-control", "no-store");
    admission.forEach((value, key) => headers.set(key, value));
    return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
  };
}
