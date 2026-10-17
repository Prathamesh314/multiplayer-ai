import type { MessageAttachment } from "../events/types";

/** Mirrors the server defaults (lib/ai/attachments.ts); the server enforces them. */
export const ATTACHMENT_MAX_BYTES = 30 * 1024 * 1024;
export const MAX_ATTACHMENTS = 20;
/** Pastes longer than this become an attachment, as in Claude Code. */
export const PASTE_AS_FILE_CHARS = 4_000;

export function formatBytes(bytes: number) {
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  if (bytes >= 1024) return `${Math.ceil(bytes / 1024)} KB`;
  return `${bytes} B`;
}

export const attachmentUrl = (sessionId: string, id: string) =>
  `/api/sessions/${encodeURIComponent(sessionId)}/attachments/${encodeURIComponent(id)}`;

/**
 * Upload one file: ask the room for a one-time link, then stream the bytes to
 * it. The second request bypasses the Next proxy, so large files arrive whole.
 */
export async function uploadAttachment(
  sessionId: string,
  file: File,
  onProgress: (fraction: number) => void,
  signal?: AbortSignal,
): Promise<MessageAttachment> {
  const response = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}/attachments`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: file.name, size: file.size, contentType: file.type || "application/octet-stream" }),
    signal,
  });
  const ticket = (await response.json().catch(() => ({}))) as { id?: string; token?: string; uploadUrl?: string; error?: string };
  if (!response.ok || !ticket.token || !ticket.uploadUrl) throw new Error(ticket.error ?? `Could not attach ${file.name}.`);
  // XMLHttpRequest, because fetch cannot report upload progress.
  return new Promise((resolve, reject) => {
    const request = new XMLHttpRequest();
    request.open("PUT", ticket.uploadUrl!);
    request.setRequestHeader("authorization", `Bearer ${ticket.token}`);
    request.setRequestHeader("content-type", "application/octet-stream");
    request.upload.onprogress = (event) => { if (event.lengthComputable) onProgress(event.loaded / event.total); };
    request.onload = () => {
      let body: (MessageAttachment & { error?: string }) | null = null;
      try { body = JSON.parse(request.responseText); } catch { /* not JSON */ }
      if (request.status >= 200 && request.status < 300 && body?.id) resolve(body);
      else reject(new Error(body?.error ?? `Could not upload ${file.name}.`));
    };
    request.onerror = () => reject(new Error(`Could not upload ${file.name}. Check your connection and try again.`));
    request.onabort = () => reject(new DOMException("Upload cancelled.", "AbortError"));
    signal?.addEventListener("abort", () => request.abort(), { once: true });
    request.send(file);
  });
}

/** Drop an unsent upload (best effort; unsent uploads also expire after a day). */
export function discardAttachment(sessionId: string, id: string) {
  void fetch(attachmentUrl(sessionId, id), { method: "DELETE" }).catch(() => {});
}
