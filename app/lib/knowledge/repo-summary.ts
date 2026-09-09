/*
 * Distilling a repository snapshot into memory-sized context chunks.
 *
 * The output feeds the repo-context bank: each chunk becomes one vector the
 * sidecar can recall against a prompt. Chunks are small (≤ MAX_CHUNK_CHARS) and
 * self-describing — every one carries the paths it covers — because a recall
 * returns chunks in isolation, with none of their neighbours for context.
 *
 * What gets indexed, in priority order:
 *   1. a file map (top-level layout + root files) — the orientation chunk;
 *   2. manifests (package.json etc.) — names, scripts, dependencies;
 *   3. root docs (README, ARCHITECTURE, AGENTS, CONTRIBUTING) — excerpts;
 *   4. export/def signatures of source files — the API surface, batched
 *      several files per chunk.
 *
 * Pure string work (no git, no fs): the caller supplies the tracked paths and
 * whichever file contents it sampled, so all of this is unit-testable and the
 * I/O policy (how many files to read, how) stays in repo-context.ts.
 */

/** One indexable chunk, ready to `remember` into the repo bank. */
export type RepoChunk = { label: string; content: string };

export const MAX_CHUNK_CHARS = 1200;
/** Total chunk budget per index pass: bounds `remember` calls per HEAD. */
export const MAX_CHUNKS = 30;
/** How many files the indexer should sample contents for. */
export const MAX_SAMPLED_FILES = 80;

/** Directories that are vendored/generated — never context, often huge. */
const IGNORED_DIRS = new Set([
  "node_modules", ".next", ".git", "dist", "build", "out", "coverage",
  "vendor", "target", "__pycache__", ".venv", ".idea", ".vscode",
]);

/** Lockfiles pin versions; the manifest already names the dependencies. */
const IGNORED_FILES = new Set([
  "package-lock.json", "yarn.lock", "pnpm-lock.yaml", "cargo.lock",
  "poetry.lock", "gemfile.lock", "composer.lock", "uv.lock",
]);

const SOURCE_EXT = new Set([
  "ts", "tsx", "js", "jsx", "mjs", "cjs", "py", "go", "rs", "rb",
  "java", "kt", "swift", "c", "h", "cc", "cpp", "hpp", "cs", "php",
]);

const DOC_NAMES = new Set(["readme.md", "architecture.md", "agents.md", "contributing.md"]);
const MANIFEST_NAMES = new Set([
  "package.json", "pyproject.toml", "cargo.toml", "go.mod", "gemfile", "requirements.txt",
]);

const extOf = (path: string): string => {
  const dot = path.lastIndexOf(".");
  return dot >= 0 ? path.slice(dot + 1).toLowerCase() : "";
};

const baseOf = (path: string): string => path.slice(path.lastIndexOf("/") + 1).toLowerCase();

const depthOf = (path: string): number => path.split("/").length;

/** Is this path worth indexing at all? */
export function isIndexablePath(path: string): boolean {
  const segments = path.split("/");
  if (segments.some((segment) => IGNORED_DIRS.has(segment.toLowerCase()))) return false;
  return !IGNORED_FILES.has(baseOf(path));
}

/**
 * Which files the indexer should read contents for: root docs and manifests
 * always, then source files shallowest-first (entry points and public modules
 * sit near the root; deep leaves matter least when the budget runs out).
 */
export function chooseSampleFiles(paths: string[], cap = MAX_SAMPLED_FILES): string[] {
  const indexable = paths.filter(isIndexablePath);
  const docs = indexable.filter(
    (path) => depthOf(path) === 1 && (DOC_NAMES.has(baseOf(path)) || MANIFEST_NAMES.has(baseOf(path))),
  );
  const source = indexable
    .filter((path) => SOURCE_EXT.has(extOf(path)) && !docs.includes(path))
    .sort((a, b) => depthOf(a) - depthOf(b) || a.localeCompare(b));
  return [...docs, ...source].slice(0, cap);
}

/** The orientation chunk: top-level layout with file counts, plus root files. */
function fileMapChunk(paths: string[]): RepoChunk {
  const byTop = new Map<string, number>();
  const rootFiles: string[] = [];
  for (const path of paths) {
    const slash = path.indexOf("/");
    if (slash < 0) {
      rootFiles.push(path);
      continue;
    }
    const top = path.slice(0, slash);
    byTop.set(top, (byTop.get(top) ?? 0) + 1);
  }
  const dirs = [...byTop.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([dir, count]) => `- ${dir}/: ${count} files`);
  const content = [
    `Repository map — ${paths.length} tracked files.`,
    ...dirs,
    rootFiles.length > 0 ? `Root files: ${rootFiles.slice(0, 20).join(", ")}` : "",
  ]
    .filter(Boolean)
    .join("\n")
    .slice(0, MAX_CHUNK_CHARS);
  return { label: "map", content };
}

/** package.json compressed to what orients an agent: name, scripts, dep names. */
function packageJsonChunk(path: string, text: string): RepoChunk {
  try {
    const parsed = JSON.parse(text) as {
      name?: string;
      scripts?: Record<string, string>;
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    const scripts = Object.entries(parsed.scripts ?? {}).map(
      ([name, cmd]) => `  ${name}: ${cmd.length > 90 ? `${cmd.slice(0, 90)}…` : cmd}`,
    );
    const deps = Object.keys(parsed.dependencies ?? {});
    const devDeps = Object.keys(parsed.devDependencies ?? {});
    const content = [
      `${path} — package "${parsed.name ?? "?"}".`,
      scripts.length > 0 ? `Scripts:\n${scripts.join("\n")}` : "",
      deps.length > 0 ? `Dependencies: ${deps.join(", ")}` : "",
      devDeps.length > 0 ? `Dev dependencies: ${devDeps.join(", ")}` : "",
    ]
      .filter(Boolean)
      .join("\n")
      .slice(0, MAX_CHUNK_CHARS);
    return { label: path, content };
  } catch {
    return excerptChunk(path, text); // malformed JSON still gets a raw excerpt
  }
}

/** A doc or unparsed manifest: the head of the file, which is where intent lives. */
function excerptChunk(path: string, text: string): RepoChunk {
  const head = text.trim().slice(0, MAX_CHUNK_CHARS - path.length - 16);
  return { label: path, content: `${path} (excerpt):\n${head}` };
}

/** Language-aware "what does this file export" line extraction. */
export function signatureLines(path: string, text: string): string[] {
  const ext = extOf(path);
  let pattern: RegExp | null = null;
  if (["ts", "tsx", "js", "jsx", "mjs", "cjs"].includes(ext)) {
    pattern = /^export\s.+|^(?:async\s+)?function\s.+|^class\s.+/;
  } else if (ext === "py") {
    pattern = /^(?:def|class)\s.+|^[A-Z_]{2,}\s*=.*/;
  } else if (ext === "go") {
    pattern = /^func\s.+|^type\s.+/;
  } else if (ext === "rs") {
    pattern = /^pub\s.+/;
  }
  if (!pattern) return [];
  return text
    .split("\n")
    .filter((line) => pattern!.test(line))
    .map((line) => (line.length > 160 ? `${line.slice(0, 160)}…` : line.trimEnd()))
    .slice(0, 12);
}

/** Batch per-file signature blocks into as few chunks as the size cap allows. */
function signatureChunks(files: ReadonlyMap<string, string>, budget: number): RepoChunk[] {
  const chunks: RepoChunk[] = [];
  let current: string[] = [];
  let currentSize = 0;

  const flush = () => {
    if (current.length === 0) return;
    chunks.push({ label: "signatures", content: `Code signatures:\n${current.join("\n")}` });
    current = [];
    currentSize = 0;
  };

  for (const [path, text] of files) {
    if (!SOURCE_EXT.has(extOf(path))) continue;
    const lines = signatureLines(path, text);
    if (lines.length === 0) continue;
    const full = `${path}:\n${lines.map((line) => `  ${line}`).join("\n")}`;
    // A single very exporty file still fits one chunk.
    const block = full.length > MAX_CHUNK_CHARS - 20 ? full.slice(0, MAX_CHUNK_CHARS - 20) : full;
    if (currentSize + block.length > MAX_CHUNK_CHARS && current.length > 0) flush();
    if (chunks.length >= budget) break;
    current.push(block);
    currentSize += block.length + 1;
  }
  if (chunks.length < budget) flush();
  return chunks;
}

/**
 * The full distillation: map + manifests + docs + signatures, capped at
 * MAX_CHUNKS. Orientation chunks come first so that when the cap bites, it
 * bites the deepest signature detail, never the map.
 */
export function summarizeRepo(input: {
  paths: string[];
  files: ReadonlyMap<string, string>;
}): RepoChunk[] {
  const paths = input.paths.filter(isIndexablePath);
  if (paths.length === 0) return [];

  const chunks: RepoChunk[] = [fileMapChunk(paths)];
  for (const [path, text] of input.files) {
    if (depthOf(path) !== 1) continue;
    const base = baseOf(path);
    if (base === "package.json") chunks.push(packageJsonChunk(path, text));
    else if (MANIFEST_NAMES.has(base) || DOC_NAMES.has(base)) chunks.push(excerptChunk(path, text));
  }
  chunks.push(...signatureChunks(input.files, MAX_CHUNKS - chunks.length));
  return chunks.slice(0, MAX_CHUNKS);
}
