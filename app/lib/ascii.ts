import type { TreeNode } from "./types";

/** Renders the tree as the familiar `tree(1)`-style text block. */
export function treeToText(root: TreeNode): string {
  const lines: string[] = [`${root.name || "."}/`];

  function walk(node: TreeNode, prefix: string) {
    const children = node.children ?? [];
    children.forEach((child, index) => {
      const isLast = index === children.length - 1;
      const branch = isLast ? "└── " : "├── ";
      const suffix = child.type === "dir" ? (child.skipped ? "/ (not scanned)" : "/") : "";
      lines.push(`${prefix}${branch}${child.name}${suffix}`);
      if (child.type === "dir" && !child.skipped) {
        walk(child, `${prefix}${isLast ? "    " : "│   "}`);
      }
    });
  }

  walk(root, "");
  return lines.join("\n");
}
