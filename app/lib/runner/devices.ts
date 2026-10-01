/*
 * Runner devices: pairing, tokens, and liveness.
 *
 * A device is one machine of one user, running the desktop app's runner
 * daemon. Pairing is a two-step handshake: a signed-in browser mints a
 * short-lived single-use code; the runner exchanges it for a long-lived
 * device token. Both are stored as SHA-256 only (the auth_tokens discipline —
 * the inputs are high-entropy random, so an unsalted hash is correct and a
 * database dump grants nothing).
 *
 * Device tokens authenticate only the runner surface (`/api/runner/*`,
 * `/api/git/*`) — never the normal web session. Revocation is immediate:
 * every request re-resolves the hash against an unrevoked row.
 */

import { createHash, randomBytes } from "node:crypto";
import { events } from "../events";
import { query, queryOne } from "../db/client";

export type RunnerDevice = {
  id: string;
  userId: string;
  name: string;
  platform: string | null;
  version: string | null;
  lastSeenAt: number | null;
  createdAt: number;
  revokedAt: number | null;
  /** Seen within the liveness window — eligible to claim jobs. */
  online: boolean;
};

/** How recent a heartbeat must be for a device to count as online. */
export const DEVICE_ONLINE_MS = 30_000;
/** Pairing codes are a one-minute-scale handshake, not a credential to keep. */
const PAIRING_CODE_TTL_MS = 10 * 60 * 1000;

const digest = (value: string): Buffer => createHash("sha256").update(value, "utf8").digest();

/** No I/O/0/1 — the code may be read off one screen and typed into another. */
const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

function randomCode(length: number): string {
  const bytes = randomBytes(length);
  let out = "";
  for (let index = 0; index < length; index += 1) {
    out += CODE_ALPHABET[bytes[index] % CODE_ALPHABET.length];
  }
  return out;
}

type DeviceRow = {
  id: string;
  user_id: string;
  name: string;
  platform: string | null;
  version: string | null;
  last_seen_at: Date | null;
  created_at: Date;
  revoked_at: Date | null;
};

const toDevice = (row: DeviceRow): RunnerDevice => ({
  id: row.id,
  userId: row.user_id,
  name: row.name,
  platform: row.platform,
  version: row.version,
  lastSeenAt: row.last_seen_at ? row.last_seen_at.getTime() : null,
  createdAt: row.created_at.getTime(),
  revokedAt: row.revoked_at ? row.revoked_at.getTime() : null,
  online:
    row.revoked_at === null &&
    row.last_seen_at !== null &&
    Date.now() - row.last_seen_at.getTime() < DEVICE_ONLINE_MS,
});

const COLUMNS = "id, user_id, name, platform, version, last_seen_at, created_at, revoked_at";

/** Mint a pairing code for the signed-in user. The raw code is returned once. */
export async function createPairingCode(userId: string): Promise<{ code: string; expiresAt: number }> {
  const code = `RN-${randomCode(4)}-${randomCode(4)}`;
  const expiresAt = new Date(Date.now() + PAIRING_CODE_TTL_MS);
  await query(
    `INSERT INTO runner_pairing_codes (code_hash, user_id, expires_at) VALUES ($1, $2, $3)`,
    [digest(code), userId, expiresAt],
  );
  return { code, expiresAt: expiresAt.getTime() };
}

/**
 * Exchange a pairing code for a device token. The claim is a single atomic
 * UPDATE — two runners racing the same code get exactly one winner — and the
 * raw token exists only in this response; the database keeps its hash.
 */
export async function exchangePairingCode(input: {
  code: string;
  name: string;
  platform?: string | null;
  version?: string | null;
}): Promise<{ device: RunnerDevice; token: string } | null> {
  const claimed = await queryOne<{ user_id: string }>(
    `UPDATE runner_pairing_codes SET used_at = now()
      WHERE code_hash = $1 AND used_at IS NULL AND expires_at > now()
      RETURNING user_id`,
    [digest(input.code.trim().toUpperCase())],
  );
  if (!claimed) return null;

  const token = `rnr_${randomBytes(32).toString("base64url")}`;
  const row = await queryOne<DeviceRow>(
    `INSERT INTO runner_devices (user_id, name, token_hash, platform, version, last_seen_at)
     VALUES ($1, $2, $3, $4, $5, now())
     RETURNING ${COLUMNS}`,
    [claimed.user_id, input.name, digest(token), input.platform ?? null, input.version ?? null],
  );
  await (await events()).publish(`user:${claimed.user_id}`,{type:'devices.changed',at:Date.now()}).catch(()=>{});
  return { device: toDevice(row!), token };
}

/**
 * Resolve a runner request's bearer token to its device, refreshing liveness.
 * Null for unknown or revoked tokens — the caller answers 401 either way, so
 * a revoked device cannot distinguish itself from a deleted one.
 */
export async function deviceFromToken(token: string | null): Promise<RunnerDevice | null> {
  if (!token) return null;
  const row = await queryOne<DeviceRow>(
    `WITH valid AS MATERIALIZED (
      SELECT ${COLUMNS} FROM runner_devices WHERE token_hash=$1 AND revoked_at IS NULL
    ), touched AS (
      UPDATE runner_devices d SET last_seen_at=now() FROM valid v
      WHERE d.id=v.id AND d.revoked_at IS NULL
        -- Leave headroom between the runner's 15s heartbeat and 30s online TTL.
        AND (d.last_seen_at IS NULL OR d.last_seen_at<now()-interval '10 seconds')
      RETURNING d.id, d.last_seen_at
    ) SELECT v.id, v.user_id, v.name, v.platform, v.version,
      COALESCE(t.last_seen_at,v.last_seen_at) AS last_seen_at, v.created_at, v.revoked_at
      FROM valid v LEFT JOIN touched t ON t.id=v.id`,
    [digest(token)],
  );
  return row ? toDevice(row) : null;
}

export async function inspectDeviceToken(token: string | null): Promise<RunnerDevice | null> {
  if (!token) return null;
  const row = await queryOne<DeviceRow>(`SELECT ${COLUMNS} FROM runner_devices WHERE token_hash=$1 AND revoked_at IS NULL`, [digest(token)]);
  return row ? toDevice(row) : null;
}

/** The bearer token out of a runner request, or null. */
export function bearerToken(request: Request): string | null {
  const header = request.headers.get("authorization") ?? "";
  return header.startsWith("Bearer ") ? header.slice(7).trim() || null : null;
}

export async function listDevices(userId: string): Promise<RunnerDevice[]> {
  const rows = await query<DeviceRow>(
    `SELECT ${COLUMNS} FROM runner_devices
      WHERE user_id = $1 AND revoked_at IS NULL
      ORDER BY created_at DESC`,
    [userId],
  );
  return rows.map(toDevice);
}

/** Revoke one of the caller's own devices. Idempotent. */
export async function revokeDevice(deviceId: string, userId: string): Promise<boolean> {
  const row = await queryOne<{ id: string }>(
    `UPDATE runner_devices SET revoked_at = now()
      WHERE id = $1 AND user_id = $2 AND revoked_at IS NULL
      RETURNING id`,
    [deviceId, userId],
  );
  if(row)await (await events()).publish(`user:${userId}`,{type:'devices.changed',at:Date.now()}).catch(()=>{});
  return row !== null;
}

/** Does this user have any device eligible to take a job right now? */
export async function hasOnlineDevice(userId: string, agentId: string, model?: string, effort?: string, anyModel = false): Promise<boolean> {
  const row = await queryOne<{ id: string }>(
    `SELECT id FROM runner_devices
      WHERE user_id = $1 AND revoked_at IS NULL
        AND last_seen_at > now() - make_interval(secs => $2)
        AND version = '2' AND $3 = ANY(agent_ids)
        AND ($6 OR runner_supports_model(model_catalog, $3, $4, $5))
      LIMIT 1`,
    [userId, DEVICE_ONLINE_MS / 1000, agentId, model ?? "", effort ?? "", anyModel],
  );
  return row !== null;
}
