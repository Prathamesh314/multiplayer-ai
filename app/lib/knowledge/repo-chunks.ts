import { createHash } from "node:crypto";
import Parser from "tree-sitter";
import TypeScript from "tree-sitter-typescript";
import JavaScript from "tree-sitter-javascript";
import Python from "tree-sitter-python";
import Go from "tree-sitter-go";
import Rust from "tree-sitter-rust";
import { isIndexablePath } from "./repo-paths";

export const CHUNK_CHARS = 2400;
export const INDEX_VERSION = 1;

export type SourceChunk = {
  id: string;
  path: string;
  startLine: number;
  endLine: number;
  symbol: string;
  content: string;
  searchText: string;
};

const languages: Record<string, unknown> = {
  ts: TypeScript.typescript, tsx: TypeScript.tsx,
  js: JavaScript, jsx: JavaScript, mjs: JavaScript, cjs: JavaScript,
  py: Python, go: Go, rs: Rust,
};
const symbols = new Set([
  "function_declaration", "generator_function_declaration", "class_declaration",
  "abstract_class_declaration", "method_definition", "interface_declaration",
  "type_alias_declaration", "enum_declaration", "variable_declarator",
  "function_definition", "class_definition", "method_declaration",
  "type_spec", "function_item", "struct_item", "enum_item", "trait_item", "impl_item",
]);
const extensions = new Set([
  ...Object.keys(languages), "mts", "cts", "rb", "java", "kt", "swift", "c", "h",
  "cc", "cpp", "hpp", "cs", "php", "vue", "svelte", "sql", "sh", "bash",
  "md", "mdx", "txt", "json", "toml", "yaml", "yml", "xml", "html", "css", "scss",
]);

export function indexableSourcePath(path: string): boolean {
  const base = path.split("/").at(-1)!.toLowerCase();
  return isIndexablePath(path) && (extensions.has(base.split(".").at(-1)!) ||
    /^(dockerfile|makefile|gemfile|procfile|license)$/.test(base));
}

/** Retain exact identifiers as tokens, and add camel/snake parts for prose. */
export function identifierText(text: string): string {
  return `${text}\n${text.replace(/([a-z0-9])([A-Z])/g, "$1 $2").replace(/[_./-]/g, " ")}`;
}

/** Preserve source, including imports and code outside symbols.
 * Supported grammars provide function/class/method boundaries. Other text and
 * malformed source fall back to bounded line chunks, without a repo-wide cap. */
export function chunkSource(path: string, text: string): SourceChunk[] {
  if (!text.trim()) return [];
  const lines = text.split("\n");
  const boundaries = new Set<number>([0, lines.length]);
  const ranges: Array<{ start: number; end: number; name: string }> = [];
  const ext = path.split(".").at(-1)!.toLowerCase();
  const language = languages[ext === "mts" || ext === "cts" ? "ts" : ext];
  if (language) {
    const parser = new Parser();
    parser.setLanguage(language);
    const tree = parser.parse(text);
    const pending: Array<{ node: Parser.SyntaxNode; parentName: string }> = [{ node: tree.rootNode, parentName: "" }];
    while (pending.length) {
      const { node, parentName } = pending.pop()!;
      let name = parentName;
      const callableVariable = node.type !== "variable_declarator" ||
        ["arrow_function", "function_expression", "class"].includes(node.childForFieldName("value")?.type ?? "");
      if (symbols.has(node.type) && callableVariable) {
        const identifier = node.childForFieldName("name") ?? node.childForFieldName("type");
        if (identifier) {
          name = parentName ? `${parentName}.${identifier.text}` : identifier.text;
          const start = node.startPosition.row;
          const end = Math.min(lines.length, node.endPosition.row + (node.endPosition.column > 0 ? 1 : 0));
          boundaries.add(start);
          boundaries.add(end);
          ranges.push({ start, end, name });
        }
      }
      for (const child of node.namedChildren.reverse()) pending.push({ node: child, parentName: name });
    }
  }

  const chunks: SourceChunk[] = [];
  const add = (start: number, end: number, symbol: string, content: string) => {
    if (!content.trim()) return;
    const id = createHash("sha256").update(`${path}\0${symbol}\0${content}`).digest("hex");
    chunks.push({ id, path, startLine: start + 1, endLine: end, symbol, content,
      searchText: identifierText(`${path}\n${symbol}\n${content}`) });
  };
  const points = [...boundaries].sort((a, b) => a - b);
  ranges.sort((a, b) => a.start - b.start || b.end - a.end);
  const active: typeof ranges = [];
  let nextRange = 0;
  for (let i = 0; i < points.length - 1; i++) {
    const start = points[i], end = points[i + 1];
    while (nextRange < ranges.length && ranges[nextRange].start <= start) active.push(ranges[nextRange++]);
    while (active.length && active.at(-1)!.end < end) active.pop();
    const scope = active.at(-1);
    let first = start;
    let buffer = "";
    for (let line = start; line < end; line++) {
      const value = lines[line];
      if (buffer && buffer.length + value.length + 1 > CHUNK_CHARS) {
        add(first, line, scope?.name ?? "", buffer);
        buffer = "";
        first = line;
      }
      if (value.length > CHUNK_CHARS) {
        for (let offset = 0; offset < value.length; offset += CHUNK_CHARS) {
          add(line, line + 1, scope?.name ?? "", value.slice(offset, offset + CHUNK_CHARS));
        }
        first = line + 1;
        continue;
      }
      buffer += `${buffer ? "\n" : ""}${value}`;
    }
    add(first, end, scope?.name ?? "", buffer);
  }
  return chunks;
}
