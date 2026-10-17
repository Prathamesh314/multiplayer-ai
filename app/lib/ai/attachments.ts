import { createHash, randomBytes, randomUUID } from "node:crypto";
import { createWriteStream } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import { query, queryOne, transaction } from "../db/client";
import { readAttachmentObject, removeAttachmentObject, storeAttachmentObject } from "../storage/blobs";

/*
 * Files attached to an AI chat message.
 *
 * Like Claude Code, Codex and Conductor, an attached file is a *file*, not
 * prompt text: the member's computer downloads it into the chat's worktree
 * (`.multicode/attachments/<turn>/`, excluded from Git) and the agent opens it
 * with its own tools, reading large files in parts. The prompt carries only
 * the list of paths, so its size no longer bounds what can be attached, and
 * any type works: code, logs, PDFs, images, archives.
 *
 * Uploading is two steps, like a presigned URL. The signed-in browser asks for
 * a one-time link (this checks room access and quota against the declared
 * size), then streams the bytes to a route outside the Next proxy, which would
 * otherwise buffer the body and truncate it at 10 MB.
 */

const MiB = 1024 * 1024;
const UPLOAD_LINK_MINUTES = 15;
const UNSENT_HOURS = 24;

function envBytes(name: string, fallback: number) {
  const value = Number(process.env[name] ?? fallback);
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`Invalid ${name}.`);
  return value;
}
/** Per file. Claude.ai allows 30 MB, which is generous for code and documents. */
export const maxAttachmentBytes = () => envBytes("ATTACHMENT_MAX_BYTES", 30 * MiB);
/** Attachment storage per org (or personal workspace); 0 means unlimited. */
export const attachmentStorageLimit = () => envBytes("ATTACHMENT_STORAGE_LIMIT_BYTES", 5 * 1024 * MiB);
export const MAX_ATTACHMENTS_PER_MESSAGE = 20;
/** Where attachments land in a chat's worktree, relative to its root. */
export const ATTACHMENT_DIR = ".multicode/attachments";

export class AttachmentError extends Error {
  constructor(message: string, public status = 400) { super(message); }
}

export type AttachmentSummary = { id: string; name: string; size: number; contentType: string };
/** What a runner needs to fetch one attachment into the worktree. */
export type AttachmentFile = { id: string; path: string; size: number; sha256: string };

type Row = { id: string; session_id: string; name: string; content_type: string; size: string; sha256: string | null };
const summary = (row: Row): AttachmentSummary => ({ id: row.id, name: row.name, size: Number(row.size), contentType: row.content_type });
const tokenHash = (token: string) => createHash("sha256").update(token).digest();

export const isAttachmentId = (value: unknown): value is string =>
  typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value);

/** A display name: no paths or control characters, at most 255 characters. */
export function cleanName(name: unknown) {
  const base = String(name ?? "").split(/[\\/]/).pop() ?? "";
  const cleaned = base.normalize("NFC").replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, 255);
  return cleaned || "file";
}
/** The declared media type when it is well formed; it only labels the file. */
export function cleanContentType(value: unknown) {
  const type = String(value ?? "").toLowerCase().split(";")[0].trim();
  return /^[a-z0-9][a-z0-9!#$&^_.+-]{0,126}\/[a-z0-9][a-z0-9!#$&^_.+-]{0,126}$/.test(type) ? type : "application/octet-stream";
}

/**
 * A file name safe on every OS, unique within one message. Extensions are kept
 * so the agent's tools recognise the type (PDFs, images, archives).
 */
export function worktreeNames(names: string[]) {
  const used = new Set<string>();
  return names.map((name) => {
    let safe = name.replace(/[<>:"|?*\\/]/g, "_").replace(/\s+/g, " ").replace(/^[.\s]+|[.\s]+$/g, "") || "file";
    if (/^(con|prn|aux|nul|com\d|lpt\d)(\.|$)/i.test(safe)) safe = `_${safe}`;
    const dot = safe.lastIndexOf(".");
    let stem = dot > 0 ? safe.slice(0, dot) : safe, ext = dot > 0 ? safe.slice(dot) : "";
    if (ext.length > 16) { stem = safe; ext = ""; }
    stem = stem.slice(0, 100);
    let candidate = `${stem}${ext}`;
    for (let n = 2; used.has(candidate.toLowerCase()); n += 1) candidate = `${stem}-${n}${ext}`;
    used.add(candidate.toLowerCase());
    return candidate;
  });
}

/** The few lines the agent sees about its attachments. */
export function attachmentPromptBlock(files: (AttachmentFile & { contentType: string })[]) {
  if (!files.length) return "";
  const size = (bytes: number) => bytes >= MiB ? `${(bytes / MiB).toFixed(1)} MB` : bytes >= 1024 ? `${Math.ceil(bytes / 1024)} KB` : `${bytes} bytes`;
  return `\n\n<attachments>\nThe user attached ${files.length === 1 ? "this file" : "these files"}. ${files.length === 1 ? "It is" : "They are"} in your working directory, outside the repository's history: read ${files.length === 1 ? "it" : "them"} with your file tools, and read large files in parts rather than all at once. Do not commit, move or delete ${files.length === 1 ? "it" : "them"}.\n${
    files.map((file) => `- ${file.path} (${size(file.size)}, ${file.contentType})`).join("\n")
  }\n</attachments>`;
}

async function ownerOf(sessionId: string) {
  const row = await queryOne<{ owner: string }>(
    `SELECT COALESCE('org:'||org_id::text, 'user:'||owner_id::text) AS owner FROM sessions WHERE id=$1`, [sessionId]);
  if (!row) throw new AttachmentError("Room not found.", 404);
  return row.owner;
}

/** Step one: record the file and hand back a one-time upload token. */
export async function createUpload(input: { sessionId: string; userId: string; name: unknown; size: unknown; contentType: unknown }) {
  const size = Number(input.size);
  const max = maxAttachmentBytes();
  if (!Number.isSafeInteger(size) || size < 0) throw new AttachmentError("Invalid file size.");
  if (size > max) throw new AttachmentError(`Files can be up to ${Math.floor(max / MiB)} MB each.`, 413);
  const owner = await ownerOf(input.sessionId);
  const id = randomUUID(), token = randomBytes(32).toString("base64url");
  await transaction(async (tx) => {
    const limit = attachmentStorageLimit();
    if (limit > 0) {
      await tx.query(`SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`, [`attachments:${owner}`]);
      const used = Number((await tx.query<{ bytes: string }>(
        `SELECT COALESCE(sum(a.size), 0) AS bytes FROM chat_attachments a JOIN sessions s ON s.id = a.session_id
          WHERE COALESCE('org:'||s.org_id::text, 'user:'||s.owner_id::text) = $1`, [owner])).rows[0].bytes);
      if (used + size > limit) throw new AttachmentError("Your workspace has used its attachment storage. Delete old chats or ask an administrator to raise the limit.", 507);
    }
    await tx.query(
      `INSERT INTO chat_attachments(id, session_id, uploaded_by, name, content_type, size, upload_token_hash) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [id, input.sessionId, input.userId, cleanName(input.name), cleanContentType(input.contentType), size, tokenHash(token)]);
  });
  return { id, token };
}

/** Who an upload token belongs to, for rate limiting before the body is read. */
export async function uploadTokenUser(token: string) {
  if (!/^[A-Za-z0-9_-]{43}$/.test(token)) return null;
  return (await queryOne<{ uploaded_by: string }>(`SELECT uploaded_by FROM chat_attachments WHERE upload_token_hash=$1`, [tokenHash(token)]))?.uploaded_by ?? null;
}

/**
 * Step two: stream the bytes to storage. The token works once, for its
 * declared size, within 15 minutes; nothing is buffered in memory.
 */
export async function receiveUpload(token: string, body: ReadableStream<Uint8Array> | null): Promise<AttachmentSummary> {
  if (!/^[A-Za-z0-9_-]{43}$/.test(token)) throw new AttachmentError("This upload link is invalid or has expired.", 404);
  // Spending the token first makes it single-use even if two uploads race.
  const row = await queryOne<Row>(
    `UPDATE chat_attachments SET upload_token_hash = NULL
      WHERE upload_token_hash = $1 AND uploaded_at IS NULL AND created_at > now() - make_interval(mins => $2)
      RETURNING id, session_id, name, content_type, size, sha256`, [tokenHash(token), UPLOAD_LINK_MINUTES]);
  if (!row) throw new AttachmentError("This upload link is invalid or has expired.", 404);
  if (!body) throw new AttachmentError("The file was empty or did not arrive.");
  const expected = Number(row.size);
  const directory = await mkdtemp(join(tmpdir(), "attachment-"));
  try {
    const path = join(directory, "upload");
    const hash = createHash("sha256");
    const file = createWriteStream(path, { mode: 0o600 });
    let received = 0;
    // Read the body to its end even when it overflows: cancelling the request
    // stream makes Next throw an uncaught "ReadableStream is already closed".
    // The gateway bounds how much a client can send.
    const reader = body.getReader();
    try {
      for (let next = await reader.read(); !next.done; next = await reader.read()) {
        received += next.value.length;
        if (received > expected) continue;
        hash.update(next.value);
        if (!file.write(next.value)) await once(file, "drain");
      }
    } finally {
      await new Promise<void>((resolve, reject) => file.end((error?: Error | null) => (error ? reject(error) : resolve())));
    }
    if (received > expected) throw new AttachmentError("The file is larger than declared.", 413);
    if (received !== expected) throw new AttachmentError("The upload was incomplete. Attach the file again.");
    await storeAttachmentObject(row.id, path);
    const sha256 = hash.digest("hex");
    await query(`UPDATE chat_attachments SET sha256 = $2, uploaded_at = now() WHERE id = $1`, [row.id, sha256]);
    return summary(row);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

/** Uploaded, unsent attachments this member may send in this room, in order. */
export async function sendableAttachments(ids: unknown, sessionId: string, userId: string) {
  if (ids == null) return [];
  if (!Array.isArray(ids) || ids.length > MAX_ATTACHMENTS_PER_MESSAGE || !ids.every(isAttachmentId) || new Set(ids).size !== ids.length)
    throw new AttachmentError(`Attach up to ${MAX_ATTACHMENTS_PER_MESSAGE} files to a message.`);
  if (!ids.length) return [];
  const rows = await query<Row>(
    `SELECT id, session_id, name, content_type, size, sha256 FROM chat_attachments
      WHERE id = ANY($1::uuid[]) AND session_id = $2 AND uploaded_by = $3 AND uploaded_at IS NOT NULL AND turn_id IS NULL`,
    [ids, sessionId, userId]);
  if (rows.length !== ids.length) throw new AttachmentError("An attachment is no longer available. Remove it and attach the file again.", 409);
  const byId = new Map(rows.map((row) => [row.id, row]));
  return ids.map((id) => byId.get(id)!);
}

/** Where each attachment goes in the turn's worktree. */
export function attachmentFiles(turnId: string, rows: Awaited<ReturnType<typeof sendableAttachments>>) {
  const names = worktreeNames(rows.map((row) => row.name));
  return rows.map((row, index) => ({
    id: row.id, size: Number(row.size), sha256: row.sha256!, contentType: row.content_type,
    path: `${ATTACHMENT_DIR}/${turnId}/${names[index]}`,
  }));
}

/** Bind the attachments to the turn and message that sent them, exactly once. */
export async function bindAttachments(ids: string[], turnId: string, messageId: string) {
  if (!ids.length) return;
  const { length } = await query(
    `UPDATE chat_attachments SET turn_id = $2, message_id = $3 WHERE id = ANY($1::uuid[]) AND turn_id IS NULL AND uploaded_at IS NOT NULL RETURNING id`,
    [ids, turnId, messageId]);
  if (length !== ids.length) throw new AttachmentError("An attachment was already sent with another message. Attach it again.", 409);
}

/** One uploaded attachment in a room, for a member downloading it. */
export async function roomAttachment(sessionId: string, id: string, userId: string) {
  if (!isAttachmentId(id)) return null;
  // Sent attachments are visible to the room; an unsent one only to its uploader.
  return queryOne<Row>(
    `SELECT id, session_id, name, content_type, size, sha256 FROM chat_attachments
      WHERE id = $1 AND session_id = $2 AND uploaded_at IS NOT NULL AND (turn_id IS NOT NULL OR uploaded_by = $3)`,
    [id, sessionId, userId]);
}
export const openAttachment = readAttachmentObject;

/** An unsent upload its owner removed from the composer. */
export async function discardUpload(sessionId: string, id: string, userId: string) {
  if (!isAttachmentId(id)) return false;
  return (await query(`DELETE FROM chat_attachments WHERE id=$1 AND session_id=$2 AND uploaded_by=$3 AND turn_id IS NULL RETURNING id`,
    [id, sessionId, userId])).length > 0;
}

/**
 * Worker housekeeping: drop uploads never sent within a day (including those
 * whose chat was deleted), then remove the objects of deleted attachments.
 */
export async function sweepAttachments(limit = 200) {
  await query(`DELETE FROM chat_attachments WHERE id IN (
    SELECT id FROM chat_attachments WHERE turn_id IS NULL AND created_at < now() - make_interval(hours => $1) LIMIT $2)`, [UNSENT_HOURS, limit]);
  const queued = await query<{ id: string }>(`SELECT id FROM chat_attachment_deletions ORDER BY queued_at LIMIT $1`, [limit]);
  let removed = 0;
  for (const { id } of queued) {
    try {
      await removeAttachmentObject(id);
      await query(`DELETE FROM chat_attachment_deletions WHERE id=$1`, [id]);
      removed += 1;
    } catch (error) {
      console.warn("Attachment cleanup deferred", error instanceof Error ? error.message : error);
    }
  }
  return removed;
}
