import type { TreeNode } from "./types";

/** Dirs before files, then natural order — the ordering VS Code uses. */
export function compareNodes(a: TreeNode, b: TreeNode): number {
  if (a.type !== b.type) return a.type === "dir" ? -1 : 1;
  return a.name.localeCompare(b.name, undefined, { numeric: true });
}

export function sortTree(node: TreeNode): void {
  node.children?.sort(compareNodes);
  for (const child of node.children ?? []) {
    if (child.type === "dir") sortTree(child);
  }
}

export type TreeEntry = { path: string; size: number };

/**
 * Builds a nested tree from a flat list of file paths. Used for anything that
 * arrives already flattened — a `git ls-tree` listing, or a folder `<input>`.
 */
export function buildTree(rootName: string, entries: TreeEntry[]): TreeNode {
  const root: TreeNode = { name: rootName, path: "", type: "dir", children: [] };
  const dirs = new Map<string, TreeNode>([["", root]]);

  for (const entry of entries) {
    const segments = entry.path.split("/");
    let parent = root;
    let parentPath = "";

    for (const name of segments.slice(0, -1)) {
      const childPath = parentPath ? `${parentPath}/${name}` : name;
      let dir = dirs.get(childPath);
      if (!dir) {
        dir = { name, path: childPath, type: "dir", children: [] };
        dirs.set(childPath, dir);
        parent.children!.push(dir);
      }
      parent = dir;
      parentPath = childPath;
    }

    parent.children!.push({
      name: segments[segments.length - 1],
      path: entry.path,
      type: "file",
      size: entry.size,
    });
  }

  sortTree(root);
  return root;
}
