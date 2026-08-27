import { collectStats } from "../scan";
import { currentTabId } from "../tab-id";
import type { GitInfo, ScanResult, TreeNode } from "../types";
import type {
  ChangedFile,
  ChangesResponse,
  FileResponse,
  SaveFileResponse,
  SeedResponse,
  Session,
  SessionRepo,
  TreeResponse,
} from "./types";

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

export type SeedProgress = { uploaded: number; total: number };

/**
 * Uploads a scanned folder into a session, in batches, and commits it. Returns
 * the git state that becomes the session's entire persistent record.
 */
export async function seedSession(
  sessionId: string,
  result: ScanResult,
  onProgress?: (progress: SeedProgress) => void,
): Promise<{ repo: SessionRepo; skipped: string[] }> {
  const paths = filePathsOf(result.root);
  const skipped: string[] = [];
  let uploaded = 0;

  let batch: { path: string; data: string }[] = [];
  let batchBytes = 0;

  const flush = async (done: boolean) => {
    const response = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}/seed`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        files: batch,
        done,
        rootName: done ? result.rootName : undefined,
        upstreamUrl: done ? (result.git.remotes[0]?.url ?? null) : undefined,
      }),
    });
    if (!response.ok) throw new Error(await readError(response, "Could not upload the folder."));

    const body = (await response.json()) as SeedResponse;
    skipped.push(...body.skipped);
    uploaded += batch.length;
    onProgress?.({ uploaded, total: paths.length });

    batch = [];
    batchBytes = 0;
    return body.repo;
  };

  for (const path of paths) {
    const bytes = await result.readBytes(path);
    if (!bytes) {
      skipped.push(path);
      continue;
    }

    batch.push({ path, data: toBase64(bytes) });
    batchBytes += bytes.byteLength;

    if (batch.length >= FILES_PER_BATCH || batchBytes >= BYTES_PER_BATCH) await flush(false);
  }

  // The final call always runs, even with an empty batch: it is what commits.
  const repo = await flush(true);
  if (!repo) throw new Error("The folder uploaded but the session repository was not created.");

  return { repo, skipped };
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
export async function fetchChanges(sessionId: string): Promise<ChangedFile[]> {
  const response = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}/changes`, {
    cache: "no-store",
  });
  if (!response.ok) return [];
  const body = (await response.json()) as ChangesResponse;
  return body.changes ?? [];
}

export async function scanSession(session: Session): Promise<ScanResult> {
  const id = session.id;
  const response = await fetch(`/api/sessions/${encodeURIComponent(id)}/tree`, {
    cache: "no-store",
  });
  if (!response.ok) throw new Error(await readError(response, "Could not load this session."));

  const tree = (await response.json()) as TreeResponse;

  return {
    rootName: tree.rootName,
    root: tree.root,
    git: gitInfoOf(tree, session.repo),
    stats: collectStats(tree.root, false),
    source: "picker",
    hiddenFilesUnavailable: false,
    readFile: async (path) => {
      const file = await fetch(
        `/api/sessions/${encodeURIComponent(id)}/file?path=${encodeURIComponent(path)}`,
        { cache: "no-store" },
      );
      if (!file.ok) return null;
      const body = (await file.json()) as FileResponse;
      return {
        text: body.text,
        size: body.size,
        truncated: body.truncated,
        binary: body.binary,
      };
    },
    readBytes: async (path) => {
      const file = await fetch(
        `/api/sessions/${encodeURIComponent(id)}/file?path=${encodeURIComponent(path)}&raw=1`,
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
): Promise<SaveFileResponse> {
  const response = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}/file`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ path, text, originId: currentTabId() }),
  });
  if (!response.ok) throw new Error(await readError(response, "Could not save this file."));
  return (await response.json()) as SaveFileResponse;
}

export type Saver = {
  /** Queues a save; repeated calls for the same path collapse into one. */
  queue(path: string, text: string): void;
  /** Writes everything pending right now — for tab close or unload. */
  flush(): Promise<void>;
};

const SAVE_DEBOUNCE_MS = 1200;

/**
 * Human edits have no turn boundary to commit on, so they get a debounced one.
 * Without this the "never uncommitted" invariant only holds for agent turns,
 * and a person typing for twenty minutes would still lose the lot on a refresh.
 */
export function createSaver(
  sessionId: string,
  onSaved?: (path: string, text: string, headSha: string) => void,
  onError?: (message: string) => void,
): Saver {
  const pending = new Map<string, string>();
  let timer: ReturnType<typeof setTimeout> | null = null;
  let inFlight: Promise<void> = Promise.resolve();

  async function writePending(): Promise<void> {
    const batch = [...pending];
    pending.clear();

    for (const [path, text] of batch) {
      try {
        const result = await saveSessionFile(sessionId, path, text);
        // The saved text is reported back so the caller can tell whether the
        // buffer moved on while the request was in flight.
        onSaved?.(path, text, result.headSha);
      } catch (cause) {
        // Put it back so the next flush retries rather than dropping the edit.
        if (!pending.has(path)) pending.set(path, text);
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
    queue(path, text) {
      pending.set(path, text);
      schedule();
    },
    async flush() {
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      inFlight = inFlight.then(writePending);
      await inFlight;
    },
  };
}
