import { collectStats } from "../scan";
import { currentTabId } from "../tab-id";
import type { GitInfo, ScanResult, TreeNode } from "../types";
import type {
  ChangesResponse,
  ChangeDiffResponse,
  FileResponse,
  SaveFileResponse,
  SeedResponse,
  Session,
  SessionRepo,
  TreeResponse,
} from "./types";
import type { RoomRepo } from "./roomRepos";

export type { RoomRepo };

/**
 * The client half of "git is the source of truth". Once a folder has been
 * seeded, the browser stops owning it: the tree, every file read, and every
 * save go through the session repo on the server.
 */

const FILES_PER_BATCH = 200;
/** Roughly the largest batch payload worth sending in one request. */
const BYTES_PER_BATCH = 6 * 1024 * 1024;

async function readError(response: Response, fallback: string): Promise<string> {
  const body = (await response.json().catch(() => null)) as { error?: string } | null;
  return body?.error ?? fallback;
}

// ---------------------------------------------------------------------------
// Seeding
// ---------------------------------------------------------------------------

export type SeedProgress = { uploaded: number; total: number; phase?: "uploading" | "finalizing" };

/**
 * The shared batch uploader behind both seed targets: the session's own repo
 * and a room repo being imported. Streams the scan in bounded batches to
 * `url`, fires the final (committing) call even when empty, and returns the
 * final response body for the caller to read its own shape out of.
 */
/**
 * The request body for one batch, compressed when the browser can.
 *
 * An import's cost is almost all bytes on the wire — the Git side writes
 * 10,000 files in about a second — and base64 inside JSON adds a third on top
 * of the source. Gzip takes a batch of real source from roughly 4 MiB to 1.2.
 * CompressionStream is absent in older browsers, so this degrades to the plain
 * JSON the server still accepts.
 */
async function encodeBatch(value: unknown): Promise<{ body: BodyInit; headers: Record<string, string> }> {
  const json = JSON.stringify(value);
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (typeof CompressionStream === "undefined") return { body: json, headers };
  try {
    const compressed = new Blob([json]).stream().pipeThrough(new CompressionStream("gzip"));
    return { body: await new Response(compressed).arrayBuffer(), headers: { ...headers, "content-encoding": "gzip" } };
  } catch {
    return { body: json, headers };
  }
}

/**
 * The shared batch uploader behind both seed targets: the session's own repo
 * and a room repo being imported. Streams the scan in bounded batches to
 * `url`, fires the final (committing) call even when empty, and returns the
 * final response body for the caller to read its own shape out of.
 *
 * One request is in flight at a time — server-side writes serialize on a
 * repository lock, so overlapping them would only queue behind it — but the
 * next batch is read, encoded and compressed *while* that request is in
 * flight. Reading used to sit idle waiting for each round trip, which on a
 * link to the server is most of an import's wall-clock time.
 */
async function uploadScan<T extends { skipped: string[] }>(
  url: string,
  result: ScanResult,
  onProgress?: (progress: SeedProgress) => void,
): Promise<{ final: T; skipped: string[] }> {
  const paths = filePathsOf(result.root);
  const skipped: string[] = [];
  let uploaded = 0;
  onProgress?.({ uploaded, total: paths.length, phase: "uploading" });

  let batch: { path: string; data: string }[] = [];
  let batchBytes = 0;
  /** The batch currently on the wire; awaited before another one starts. */
  let inFlight: Promise<T> | null = null;

  const send = async (files: { path: string; data: string }[], done: boolean): Promise<T> => {
    const { body, headers } = await encodeBatch({
      files,
      done,
      rootName: done ? result.rootName : undefined,
      upstreamUrl: done ? (result.git.remotes[0]?.url ?? null) : undefined,
    });
    const payload = { method: "POST", headers, body };

    let response: Response | undefined;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        response = await fetch(url, payload);
        if (response.status < 500 && response.status !== 429) break;
      } catch (cause) {
        if (attempt === 2) throw cause;
      }
      if (attempt < 2) {
        const seconds = Number(response?.headers.get("retry-after"));
        const delay = response?.status === 429 && Number.isFinite(seconds) && seconds > 0
          ? Math.min(60_000, seconds * 1000) : 500 * (attempt + 1);
        await response?.body?.cancel();
        await new Promise(resolve => setTimeout(resolve, delay));
      }
    }
    if (!response?.ok) throw new Error(response ? await readError(response, "Could not upload the folder.") : "Upload interrupted. Pick the same folder again to retry.");

    const parsed = (await response.json()) as T;
    skipped.push(...parsed.skipped);
    uploaded += files.length;
    onProgress?.({ uploaded, total: paths.length, phase: done ? "finalizing" : "uploading" });
    return parsed;
  };

  /** Hand the current batch to the wire, after the previous one lands. */
  const dispatch = async () => {
    const files = batch;
    batch = [];
    batchBytes = 0;
    // Awaiting here, before starting the next request rather than after
    // building it, is what bounds memory: one batch in flight, one being read.
    if (inFlight) await inFlight;
    inFlight = send(files, false);
  };

  for (const path of paths) {
    const bytes = await result.readBytes(path);
    if (!bytes) {
      skipped.push(path);
      continue;
    }

    // Flush before adding the next file, rather than retaining two large files
    // in the same request. A single allowed file can exceed the batch target.
    if (batch.length && batchBytes + bytes.byteLength > BYTES_PER_BATCH) await dispatch();
    batch.push({ path, data: toBase64(bytes) });
    batchBytes += bytes.byteLength;

    if (batch.length >= FILES_PER_BATCH || batchBytes >= BYTES_PER_BATCH) await dispatch();
  }

  // The final call always runs, even with an empty batch: it is what commits,
  // and it must land after every earlier batch.
  if (inFlight) await inFlight;
  onProgress?.({ uploaded, total: paths.length, phase: "finalizing" });
  const final = await send(batch, true);
  return { final, skipped };
}

/**
 * Uploads a scanned folder into a session, in batches, and commits it. Returns
 * the git state that becomes the session's entire persistent record.
 */
export async function seedSession(
  sessionId: string,
  result: ScanResult,
  onProgress?: (progress: SeedProgress) => void,
): Promise<{ repo: SessionRepo; skipped: string[] }> {
  const { final, skipped } = await uploadScan<SeedResponse>(
    `/api/sessions/${encodeURIComponent(sessionId)}/seed`,
    result,
    onProgress,
  );
  if (!final.repo) throw new Error("The folder uploaded but the session repository was not created.");
  return { repo: final.repo, skipped };
}

// ---------------------------------------------------------------------------
// Room repos (additional codebases imported into a room)
// ---------------------------------------------------------------------------

/** Make a repository you added private to you, or visible to the room again. */
export async function changeRoomRepoVisibility(sessionId: string, repoId: string, visibility: "room" | "private"): Promise<RoomRepo> {
  const response = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}/repos/${encodeURIComponent(repoId)}`, {
    method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ visibility }),
  });
  if (!response.ok) throw new Error(await readError(response, "Could not change who sees this repository."));
  return ((await response.json()) as { repo: RoomRepo }).repo;
}

/** Delete a repository from the room, with its chats. */
export async function deleteRoomRepo(sessionId: string, repoId: string): Promise<{ chats: number }> {
  const response = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}/repos/${encodeURIComponent(repoId)}`, { method: "DELETE" });
  if (!response.ok) throw new Error(await readError(response, "Could not delete this repository."));
  return (await response.json()) as { chats: number };
}

export async function fetchRoomRepos(sessionId: string): Promise<RoomRepo[]> {
  const response = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}/repos`, {
    cache: "no-store",
  });
  if (!response.ok) throw new Error(await readError(response, "Could not load imported repositories."));
  const body = (await response.json()) as { repos: RoomRepo[] };
  return body.repos ?? [];
}

/** Start a ready-to-chat workspace without uploading or attaching any files. */
export async function createEmptyRoomRepo(sessionId: string, name: string): Promise<RoomRepo> {
  let response: Response;
  try {
    response = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}/repos`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: name.trim(), empty: true }),
    });
  } catch {
    throw new Error("Could not reach the server. Check your connection and try again.");
  }
  if (!response.ok) throw new Error(await readError(response, "Could not create the conversation space. Please try again."));
  const { repo } = (await response.json()) as { repo: RoomRepo };
  if (!repo?.headSha || !repo.seededAt) throw new Error("The project is not ready yet. Refresh the page and try again.");
  return repo;
}

/**
 * Imports a scanned folder as a new repo in the room: allocates the record,
 * then streams the files into it and commits. Returns the finished repo.
 */
export async function importRoomRepo(
  sessionId: string,
  result: ScanResult,
  onProgress?: (progress: SeedProgress) => void,
): Promise<{ repo: RoomRepo; skipped: string[] }> {
  const name = result.rootName?.trim() || "imported";
  const created = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}/repos`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name }),
  });
  if (!created.ok) throw new Error(await readError(created, "Could not create the repo."));
  const { repo } = (await created.json()) as { repo: RoomRepo };

  const { final, skipped } = await uploadScan<{ skipped: string[]; headSha: string | null }>(
    `/api/sessions/${encodeURIComponent(sessionId)}/repos/${encodeURIComponent(repo.id)}/seed`,
    result,
    onProgress,
  );
  if (!final.headSha) throw new Error("The folder uploaded but the repo was not committed.");
  return { repo: { ...repo, headSha: final.headSha, seededAt: Date.now() }, skipped };
}

function filePathsOf(root: TreeNode): string[] {
  const paths: string[] = [];
  const stack: TreeNode[] = [root];

  while (stack.length > 0) {
    const node = stack.pop()!;
    if (node.type === "file") {
      paths.push(node.path);
      continue;
    }
    for (const child of node.children ?? []) stack.push(child);
  }

  return paths;
}

/** Chunked so a large file cannot blow the argument limit of `String.fromCharCode`. */
function toBase64(bytes: Uint8Array): string {
  const CHUNK = 0x8000;
  let binary = "";
  for (let index = 0; index < bytes.length; index += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(index, index + CHUNK));
  }
  return btoa(binary);
}

// ---------------------------------------------------------------------------
// Reading a seeded session
// ---------------------------------------------------------------------------

/**
 * A `ScanResult` backed by the session repo instead of the local disk. The
 * explorer and editor cannot tell the difference — `readFile` was always a
 * closure over its source, which is what makes this a drop-in.
 */
/** Files changed since the session was seeded, for the explorer's Changes tab. */
export async function fetchChanges(sessionId: string, repoId: string | null = null): Promise<ChangesResponse> {
  const response = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}/changes?repoId=${encodeURIComponent(repoId ?? "")}`, {
    cache: "no-store",
  });
  if (!response.ok) throw new Error(await readError(response, "Could not load changes."));
  const body = (await response.json()) as ChangesResponse;
  return { ...body, changes: body.changes ?? [] };
}

/** One changed file's unified diff, against the same commits as `fetchChanges`. */
export async function fetchChangeDiff(sessionId: string, repoId: string | null, path: string, signal?: AbortSignal): Promise<string> {
  const response = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}/changes?repoId=${encodeURIComponent(repoId ?? "")}&path=${encodeURIComponent(path)}`, {
    cache: "no-store",
    signal,
  });
  if (!response.ok) throw new Error(await readError(response, "Could not load this file's changes."));
  return ((await response.json()) as ChangeDiffResponse).diff ?? "";
}

/** Each file is at most the editor's read limit; each request stays under the proxy's buffer. */
export const ADD_FILE_MAX_BYTES = 8 * 1024 * 1024;
const ADD_BATCH_BYTES = 8.5 * 1024 * 1024;
const ADD_BATCH_FILES = 100;

export class FilesExistError extends Error {
  constructor(public paths: string[]) { super(`${paths.length === 1 ? paths[0] : `${paths.length} files`} already exist${paths.length === 1 ? "s" : ""}.`); }
}

/**
 * Add files to the repository (New file, New folder, Upload, drag and drop).
 * Sent as raw bytes in batches under the request limit; each batch is one
 * commit. Throws FilesExistError, before anything is written, if a file
 * already exists and `overwrite` was not confirmed.
 */
export async function addRepoFiles(sessionId: string, repoId: string | null, files: { path: string; file: Blob }[], overwrite = false): Promise<{ added: string[]; replaced: string[] }> {
  const batches: { path: string; file: Blob }[][] = [];
  let current: { path: string; file: Blob }[] = [], bytes = 0;
  for (const item of files) {
    if (item.file.size > ADD_FILE_MAX_BYTES) throw new Error(`${item.path} is larger than 8 MB.`);
    if (current.length && (bytes + item.file.size > ADD_BATCH_BYTES || current.length >= ADD_BATCH_FILES)) { batches.push(current); current = []; bytes = 0; }
    current.push(item); bytes += item.file.size;
  }
  if (current.length) batches.push(current);
  const added: string[] = [], replaced: string[] = [];
  for (const batch of batches) {
    const form = new FormData();
    form.append("paths", JSON.stringify(batch.map((item) => item.path)));
    for (const item of batch) form.append("file", item.file, item.path.split("/").pop() || "file");
    if (overwrite) form.append("overwrite", "1");
    const response = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}/files?repoId=${encodeURIComponent(repoId ?? "")}`, { method: "POST", body: form });
    const body = await response.json().catch(() => ({})) as { added?: string[]; replaced?: string[]; exists?: string[]; error?: string };
    if (response.status === 409 && body.exists) throw new FilesExistError(body.exists);
    if (!response.ok) throw new Error(body.error ?? "Could not add these files.");
    added.push(...(body.added ?? [])); replaced.push(...(body.replaced ?? []));
  }
  return { added, replaced };
}

export async function scanSession(session: Session, repoId: string | null = null): Promise<ScanResult> {
  const id = session.id;
  const response = await fetch(`/api/sessions/${encodeURIComponent(id)}/tree?repoId=${encodeURIComponent(repoId ?? "")}`, {
    cache: "no-store",
  });
  if (!response.ok) throw new Error(await readError(response, "Could not load this session."));

  const tree = (await response.json()) as TreeResponse;

  return {
    rootName: tree.rootName,
    root: tree.root,
    git: gitInfoOf(tree, repoId ? null : session.repo),
    stats: collectStats(tree.root, false),
    source: "picker",
    hiddenFilesUnavailable: false,
    readFile: async (path) => {
      const file = await fetch(
        `/api/sessions/${encodeURIComponent(id)}/file?repoId=${encodeURIComponent(repoId ?? "")}&path=${encodeURIComponent(path)}`,
        { cache: "no-store" },
      );
      if (!file.ok) throw new Error(await readError(file, "Could not open this file. Try again."));
      const body = (await file.json()) as FileResponse;
      return {
        text: body.text,
        size: body.size,
        truncated: body.truncated,
        binary: body.binary,
        // Always present, so a refresh clears it once the agent is done.
        live: body.live,
      };
    },
    readBytes: async (path) => {
      const file = await fetch(
        `/api/sessions/${encodeURIComponent(id)}/file?repoId=${encodeURIComponent(repoId ?? "")}&path=${encodeURIComponent(path)}&raw=1`,
        { cache: "no-store" },
      );
      if (!file.ok) return null;
      return new Uint8Array(await file.arrayBuffer());
    },
  };
}

function gitInfoOf(tree: TreeResponse, repo: SessionRepo | null): GitInfo {
  const branches = repo
    ? [...new Set([repo.sessionBranch, repo.baseBranch])]
    : [tree.sessionBranch];

  return {
    isGit: true,
    branch: tree.sessionBranch,
    detached: false,
    head: `ref: refs/heads/${tree.sessionBranch}`,
    commit: tree.headSha,
    branches,
    remotes: [],
    lastActivity: null,
  };
}

// ---------------------------------------------------------------------------
// Saving
// ---------------------------------------------------------------------------

export async function saveSessionFile(
  sessionId: string,
  path: string,
  text: string,
  baseText?: string,
  repoId: string | null = null,
): Promise<SaveFileResponse> {
  const response = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}/file?repoId=${encodeURIComponent(repoId ?? "")}`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ path, text, baseText, originId: currentTabId() }),
  });
  // 409 is a real, expected outcome — an overlapping edit — not a failure. It
  // comes back as a conflict response the saver reconciles, not a thrown error.
  if (response.status === 409) return (await response.json()) as SaveFileResponse;
  if (!response.ok) throw new Error(await readError(response, "Could not save this file."));
  return (await response.json()) as SaveFileResponse;
}

export type Saver = {
  /**
   * Queues a save; repeated calls for the same path collapse into one.
   * `baseText` is the committed version the edit was made against, so the
   * server can merge rather than overwrite a teammate's concurrent change.
   */
  queue(path: string, text: string, baseText: string): void;
  /** Writes everything pending right now — for tab close or unload. */
  flush(): Promise<boolean>;
};

const SAVE_DEBOUNCE_MS = 1200;

type PendingSave = { text: string; baseText: string };

/**
 * Human edits have no turn boundary to commit on, so they get a debounced one.
 * Without this the "never uncommitted" invariant only holds for agent turns,
 * and a person typing for twenty minutes would still lose the lot on a refresh.
 */
export function createSaver(
  sessionId: string,
  onSaved?: (path: string, text: string, headSha: string) => void,
  onError?: (message: string) => void,
  /** Called when a save overlapped a teammate's edit and committed nothing. */
  onConflict?: (path: string) => void,
  repoId: string | null = null,
): Saver {
  const pending = new Map<string, PendingSave>();
  let timer: ReturnType<typeof setTimeout> | null = null;
  let inFlight: Promise<void> = Promise.resolve();
  let failed = false;

  async function writePending(): Promise<void> {
    const batch = [...pending];
    pending.clear();

    for (const [path, save] of batch) {
      try {
        const result = await saveSessionFile(sessionId, path, save.text, save.baseText, repoId);
        if (result.conflict) {
          // An overlapping edit — leave the user's text as-is and let them
          // reconcile; don't retry, which would just conflict again.
          failed = true;
          onConflict?.(path);
          continue;
        }
        // The saved text is reported back so the caller can tell whether the
        // buffer moved on while the request was in flight.
        onSaved?.(path, save.text, result.headSha);
      } catch (cause) {
        // Put it back so the next flush retries rather than dropping the edit.
        failed = true;
        if (!pending.has(path)) pending.set(path, save);
        onError?.(cause instanceof Error ? cause.message : "Could not save this file.");
      }
    }
  }

  function schedule() {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      inFlight = inFlight.then(writePending);
    }, SAVE_DEBOUNCE_MS);
  }

  return {
    queue(path, text, baseText) {
      pending.set(path, { text, baseText });
      schedule();
    },
    async flush() {
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      inFlight = inFlight.then(writePending);
      await inFlight;
      const success = !failed && pending.size === 0;
      failed = false;
      return success;
    },
  };
}
