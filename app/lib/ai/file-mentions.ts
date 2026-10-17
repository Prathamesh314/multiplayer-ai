import type { TreeNode } from "../types";

/*
 * Tagging files and folders of the current repository in a message with "@",
 * like `@app/lib/x.ts`. The composer offers matching paths from the explorer's
 * tree; the server tells the agent which paths were tagged, and the agent
 * reads them in its own worktree. Nothing is copied into the prompt.
 */

export type MentionFile = { path: string; dir: boolean };

export const MAX_FILE_REFS = 50;

/** Every file and folder under the root, folders first at each level. */
export function flattenPaths(root: TreeNode): MentionFile[] {
  const out: MentionFile[] = [];
  const walk = (node: TreeNode) => {
    for (const child of node.children ?? []) {
      if (!child.path) continue;
      out.push({ path: child.path, dir: child.type === "dir" });
      if (child.type === "dir") walk(child);
    }
  };
  walk(root);
  // Folders a listing leaves implicit (only file paths) are still taggable.
  const known = new Set(out.map((file) => file.path));
  for (const file of [...out]) {
    for (let at = file.path.indexOf("/"); at > 0; at = file.path.indexOf("/", at + 1)) {
      const dir = file.path.slice(0, at);
      if (!known.has(dir)) { known.add(dir); out.push({ path: dir, dir: true }); }
    }
  }
  return out;
}

const base = (path: string) => path.slice(path.lastIndexOf("/") + 1);

/**
 * The best matches for what follows "@": a name starting with it beats a name
 * containing it, which beats a match elsewhere in the path; shorter paths
 * first. With nothing typed yet, the top of the repository.
 */
export function matchFiles(files: MentionFile[], query: string, limit = 30): MentionFile[] {
  const q = query.trim().toLowerCase();
  if (!q) return files.filter((file) => !file.path.includes("/")).slice(0, limit);
  const scored: { file: MentionFile; score: number }[] = [];
  for (const file of files) {
    const path = file.path.toLowerCase(), name = base(path);
    const score = path === q ? 0 : name.startsWith(q) ? 1 : name.includes(q) ? 2 : path.startsWith(q) ? 3 : path.includes(q) ? 4 : -1;
    if (score >= 0) scored.push({ file, score });
  }
  return scored.sort((a, b) => a.score - b.score || a.file.path.length - b.file.path.length || a.file.path.localeCompare(b.file.path))
    .slice(0, limit).map((item) => item.file);
}

/** The text that tags a path in a message: folders end with "/". */
export const fileToken = (file: MentionFile) => `@${file.path}${file.dir ? "/" : ""}`;

/** Tagged paths in a message that are really in the repository. */
export function fileRefsFromText(text: string, files: MentionFile[]): string[] {
  if (!files.length || !text.includes("@")) return [];
  const known = new Map(files.map((file) => [file.path, file]));
  const refs = new Set<string>();
  for (const match of text.matchAll(/(^|\s)@(\S+)/g)) {
    const token = match[2].replace(/[.,;:!?)\]]+$/, "");
    const file = known.get(token.replace(/\/$/, ""));
    if (file) refs.add(fileToken(file).slice(1));
  }
  return [...refs].slice(0, MAX_FILE_REFS);
}

/** Paths from a request: repository-relative, no "..", nothing odd. Invalid entries are dropped. */
export function cleanFileRefs(input: unknown): string[] {
  if (!Array.isArray(input)) return [];
  const refs = new Set<string>();
  for (const value of input.slice(0, MAX_FILE_REFS)) {
    if (typeof value !== "string" || !value || value.length > 1000 || /[\0\r\n]/.test(value) || value.startsWith("/")) continue;
    if (value.split("/").some((part, index, parts) => part === ".." || part === "." || (!part && index < parts.length - 1))) continue;
    refs.add(value);
  }
  return [...refs];
}

/** What the agent is told about tagged paths. */
export function fileRefsPromptBlock(refs: string[]): string {
  if (!refs.length) return "";
  return `\n\n<tagged-files>\nThe user tagged these paths of the repository with @ (relative to its root; folders end with /). Read them in your working folder before answering:\n${refs.map((ref) => `- ${ref}`).join("\n")}\n</tagged-files>`;
}
