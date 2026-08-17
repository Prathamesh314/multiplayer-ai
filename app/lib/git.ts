import type { GitActivity, GitInfo, GitReader, GitRemote } from "./types";

const SHA_RE = /^[0-9a-f]{7,64}$/i;

const NOT_A_REPO: GitInfo = {
  isGit: false,
  branch: null,
  detached: false,
  head: null,
  commit: null,
  branches: [],
  remotes: [],
  lastActivity: null,
};

/**
 * Reads the plain-text parts of a `.git` directory: HEAD, refs, packed-refs,
 * config and the reflog. No object decompression, so no zlib in the browser.
 */
export async function readGitInfo(reader: GitReader): Promise<GitInfo> {
  const head = (await reader.readText(".git/HEAD"))?.trim() ?? null;

  if (!head) {
    // `.git` as a *file* means a linked worktree or a submodule: the real
    // git dir lives elsewhere and the browser cannot reach it.
    const gitFile = (await reader.readText(".git"))?.trim();
    if (gitFile?.startsWith("gitdir:")) {
      return {
        ...NOT_A_REPO,
        isGit: true,
        note: "Linked Git worktree or submodule — its metadata lives outside this folder, so branch details are unavailable.",
      };
    }
    const contents = await reader.listFiles(".git");
    if (contents && contents.length > 0) {
      return {
        ...NOT_A_REPO,
        isGit: true,
        note: "Found a .git folder, but .git/HEAD could not be read.",
      };
    }
    return NOT_A_REPO;
  }

  const packed = parsePackedRefs(await reader.readText(".git/packed-refs"));
  const looseHeads = await listBranches(reader);
  const branches = [...new Set([...looseHeads, ...packed.branches])].sort(
    (a, b) => a.localeCompare(b),
  );

  let branch: string | null = null;
  let detached = false;
  let commit: string | null = null;

  if (head.startsWith("ref:")) {
    const ref = head.slice(4).trim();
    branch = ref.startsWith("refs/heads/") ? ref.slice("refs/heads/".length) : ref;
    const loose = (await reader.readText(`.git/${ref}`))?.trim();
    commit = loose && SHA_RE.test(loose) ? loose : (packed.refs.get(ref) ?? null);
  } else if (SHA_RE.test(head)) {
    detached = true;
    commit = head;
  }

  return {
    isGit: true,
    branch,
    detached,
    head,
    commit,
    branches: branch && !branches.includes(branch) ? [branch, ...branches] : branches,
    remotes: parseRemotes(await reader.readText(".git/config")),
    lastActivity: parseReflogTail(await reader.readText(".git/logs/HEAD")),
  };
}

async function listBranches(reader: GitReader): Promise<string[]> {
  const paths = await reader.listFiles(".git/refs/heads");
  if (!paths) return [];
  // Nested refs (`feature/login`) arrive as nested paths already.
  return paths.filter((p) => p.length > 0 && !p.endsWith("/"));
}

function parsePackedRefs(text: string | null) {
  const refs = new Map<string, string>();
  const branches: string[] = [];
  if (!text) return { refs, branches };

  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    // `#` is a header, `^` a peeled tag target.
    if (!trimmed || trimmed.startsWith("#") || trimmed.startsWith("^")) continue;
    const spaceAt = trimmed.indexOf(" ");
    if (spaceAt < 0) continue;
    const sha = trimmed.slice(0, spaceAt);
    const ref = trimmed.slice(spaceAt + 1).trim();
    if (!SHA_RE.test(sha) || !ref) continue;
    refs.set(ref, sha);
    if (ref.startsWith("refs/heads/")) branches.push(ref.slice("refs/heads/".length));
  }
  return { refs, branches };
}

function parseRemotes(config: string | null): GitRemote[] {
  if (!config) return [];
  const remotes: GitRemote[] = [];
  let current: string | null = null;

  for (const line of config.split("\n")) {
    const trimmed = line.trim();
    const section = /^\[remote\s+"([^"]+)"\]$/.exec(trimmed);
    if (section) {
      current = section[1];
      continue;
    }
    if (trimmed.startsWith("[")) {
      current = null;
      continue;
    }
    const url = /^url\s*=\s*(.+)$/.exec(trimmed);
    if (current && url) {
      remotes.push({ name: current, url: url[1].trim() });
      current = null;
    }
  }
  return remotes;
}

/**
 * Reflog lines look like:
 * `<old> <new> Name <email> <unix ts> <tz>\t<action>: <message>`
 */
function parseReflogTail(log: string | null): GitActivity | null {
  if (!log) return null;
  const lines = log.split("\n").filter((l) => l.trim().length > 0);
  const last = lines.at(-1);
  if (!last) return null;

  const tabAt = last.indexOf("\t");
  const meta = tabAt < 0 ? last : last.slice(0, tabAt);
  const action = tabAt < 0 ? "" : last.slice(tabAt + 1).trim();

  const parsed = /^\S+\s+\S+\s+(.*?)\s+<[^>]*>\s+(\d+)\s+[+-]?\d+$/.exec(meta);
  if (!parsed) return null;

  return {
    author: parsed[1].trim(),
    timestamp: Number(parsed[2]),
    // Kept verbatim — the action prefix ("commit:", "clone:", "checkout:") is
    // the useful part.
    message: action,
  };
}

/** `git@github.com:user/repo.git` / `https://host/user/repo.git` → `user/repo`. */
export function shortRemote(url: string): string {
  return url
    .replace(/^git@([^:]+):/, "")
    .replace(/^[a-z+]+:\/\/[^/]+\//i, "")
    .replace(/\.git$/, "");
}
