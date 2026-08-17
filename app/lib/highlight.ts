import type { Grammar } from "./language";

export type TokenKind =
  | "plain"
  | "keyword"
  | "control"
  | "string"
  | "number"
  | "comment"
  | "function"
  | "type"
  | "variable"
  | "punct";

export type Token = { text: string; kind: TokenKind };

export const TOKEN_CLASS: Record<TokenKind, string> = {
  plain: "text-syn-plain",
  keyword: "text-syn-keyword",
  control: "text-syn-control",
  string: "text-syn-string",
  number: "text-syn-number",
  comment: "text-syn-comment italic",
  function: "text-syn-function",
  type: "text-syn-type",
  variable: "text-syn-variable",
  punct: "text-syn-punct",
};

/**
 * A deliberately small regex tokenizer. It is not a parser — it aims for the
 * familiar VS Code colouring on the common cases, and degrades to plain text
 * rather than mis-highlighting when it is unsure.
 */
export function tokenize(source: string, grammar: Grammar): Token[] {
  switch (grammar) {
    case "clike":
      return tokenizeCode(source, CLIKE_PATTERN);
    case "hash":
      return tokenizeCode(source, HASH_PATTERN);
    case "json":
      return tokenizeJson(source);
    case "css":
      return tokenizeCss(source);
    case "markup":
      return tokenizeMarkup(source);
    default:
      return [{ text: source, kind: "plain" }];
  }
}

// Declaration-ish keywords (blue) vs control flow (purple), as VS Code splits them.
const DECLARATION = new Set([
  "abstract", "as", "async", "auto", "await", "bool", "boolean", "byte", "char", "class",
  "const", "constructor", "declare", "def", "defer", "double", "dynamic", "enum", "export",
  "extends", "extern", "false", "final", "float", "fn", "from", "func", "function", "global",
  "impl", "implements", "import", "in", "infer", "instanceof", "int", "interface", "internal",
  "is", "keyof", "lambda", "let", "long", "map", "module", "mut", "namespace", "new", "nil",
  "None", "null", "of", "operator", "override", "package", "private", "protected", "public",
  "pub", "readonly", "record", "ref", "required", "satisfies", "sealed", "self", "short",
  "size_t", "static", "std", "str", "string", "struct", "super", "symbol", "this", "trait",
  "true", "type", "typedef", "typeof", "union", "unsafe", "use", "using", "val", "var",
  "virtual", "void", "where", "with",
]);

const CONTROL = new Set([
  "break", "case", "catch", "continue", "do", "elif", "else", "end", "except", "esac", "fi",
  "finally", "for", "foreach", "goto", "if", "loop", "match", "pass", "raise", "return",
  "select", "switch", "then", "throw", "try", "unless", "until", "when", "while", "yield",
]);

const BUILTIN_TYPES = new Set([
  "Array", "Boolean", "Date", "Error", "Map", "Number", "Object", "Promise", "Record", "Set",
  "String", "Symbol", "any", "never", "number", "object", "unknown",
]);

/**
 * Ordered alternatives: comments and strings first so their contents are never
 * re-tokenized, then numbers, identifiers and punctuation.
 */
const CLIKE_PATTERN = new RegExp(
  [
    "(?<comment>\\/\\*[\\s\\S]*?(?:\\*\\/|$)|\\/\\/[^\\n]*)",
    "(?<string>`(?:\\\\[\\s\\S]|[^`\\\\])*`?|\"(?:\\\\.|[^\"\\\\\\n])*\"?|'(?:\\\\.|[^'\\\\\\n])*'?)",
    "(?<number>\\b(?:0[xXbBoO][0-9a-fA-F_]+|\\d[\\d_]*(?:\\.[\\d_]*)?(?:[eE][+-]?\\d+)?)n?\\b)",
    "(?<word>[A-Za-z_$][\\w$]*)",
    "(?<punct>[^\\w\\s$])",
  ].join("|"),
  "gy",
);

const HASH_PATTERN = new RegExp(
  [
    "(?<comment>#[^\\n]*)",
    "(?<string>\"\"\"[\\s\\S]*?(?:\"\"\"|$)|'''[\\s\\S]*?(?:'''|$)|\"(?:\\\\.|[^\"\\\\\\n])*\"?|'(?:\\\\.|[^'\\\\\\n])*'?)",
    "(?<number>\\b\\d[\\d_]*(?:\\.[\\d_]*)?(?:[eE][+-]?\\d+)?\\b)",
    "(?<word>[A-Za-z_$][\\w$-]*)",
    "(?<punct>[^\\w\\s$-])",
  ].join("|"),
  "gy",
);

function tokenizeCode(source: string, pattern: RegExp): Token[] {
  const tokens: Token[] = [];
  const regex = new RegExp(pattern.source, pattern.flags);
  let index = 0;

  while (index < source.length) {
    regex.lastIndex = index;
    const match = regex.exec(source);

    if (!match) {
      // Whitespace or a character no alternative claimed.
      const next = skipUnmatched(source, index);
      pushToken(tokens, source.slice(index, next), "plain");
      index = next;
      continue;
    }

    const groups = match.groups!;
    if (groups.word !== undefined) {
      pushToken(tokens, groups.word, classifyWord(groups.word, source, regex.lastIndex));
    } else {
      const kind: TokenKind =
        groups.comment !== undefined
          ? "comment"
          : groups.string !== undefined
            ? "string"
            : groups.number !== undefined
              ? "number"
              : "punct";
      pushToken(tokens, match[0], kind);
    }
    index = regex.lastIndex;
  }

  return tokens;
}

function classifyWord(word: string, source: string, after: number): TokenKind {
  if (DECLARATION.has(word)) return "keyword";
  if (CONTROL.has(word)) return "control";
  if (BUILTIN_TYPES.has(word)) return "type";
  if (/^[A-Z][A-Z0-9_]*$/.test(word)) return "variable";
  if (/^[A-Z]/.test(word)) return "type";

  // `foo(` and `foo <` (generic call) read as a call site.
  const rest = source.slice(after, after + 8);
  if (/^\s*[(<]/.test(rest)) return "function";
  return "variable";
}

/** Advances past whitespace, or one character when nothing else matches. */
function skipUnmatched(source: string, index: number): number {
  const whitespace = /\s+/y;
  whitespace.lastIndex = index;
  return whitespace.exec(source) ? whitespace.lastIndex : index + 1;
}

function tokenizeJson(source: string): Token[] {
  const tokens: Token[] = [];
  const regex =
    /(?<string>"(?:\\.|[^"\\])*"?)|(?<number>-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)|(?<word>true|false|null)|(?<punct>[{}[\],:])/gy;
  let index = 0;

  while (index < source.length) {
    regex.lastIndex = index;
    const match = regex.exec(source);
    if (!match) {
      const next = skipUnmatched(source, index);
      pushToken(tokens, source.slice(index, next), "plain");
      index = next;
      continue;
    }

    const groups = match.groups!;
    if (groups.string !== undefined) {
      // A string followed by `:` is a property name.
      const isKey = /^\s*:/.test(source.slice(regex.lastIndex));
      pushToken(tokens, match[0], isKey ? "variable" : "string");
    } else {
      pushToken(
        tokens,
        match[0],
        groups.number !== undefined ? "number" : groups.word !== undefined ? "keyword" : "punct",
      );
    }
    index = regex.lastIndex;
  }

  return tokens;
}

function tokenizeCss(source: string): Token[] {
  const tokens: Token[] = [];
  const regex =
    /(?<comment>\/\*[\s\S]*?(?:\*\/|$))|(?<string>"(?:\\.|[^"\\\n])*"?|'(?:\\.|[^'\\\n])*'?)|(?<at>@[\w-]+)|(?<prop>[-\w]+(?=\s*:))|(?<number>#[0-9a-fA-F]{3,8}\b|[+-]?\d*\.?\d+(?:%|[a-z]{1,4})?)|(?<func>[\w-]+(?=\())|(?<word>[#.]?[\w-]+)|(?<punct>[^\w\s-])/gy;
  let index = 0;

  while (index < source.length) {
    regex.lastIndex = index;
    const match = regex.exec(source);
    if (!match) {
      const next = skipUnmatched(source, index);
      pushToken(tokens, source.slice(index, next), "plain");
      index = next;
      continue;
    }

    const groups = match.groups!;
    const kind: TokenKind =
      groups.comment !== undefined
        ? "comment"
        : groups.string !== undefined
          ? "string"
          : groups.at !== undefined
            ? "control"
            : groups.prop !== undefined
              ? "variable"
              : groups.number !== undefined
                ? "number"
                : groups.func !== undefined
                  ? "function"
                  : groups.word !== undefined
                    ? "type"
                    : "punct";
    pushToken(tokens, match[0], kind);
    index = regex.lastIndex;
  }

  return tokens;
}

function tokenizeMarkup(source: string): Token[] {
  const tokens: Token[] = [];
  const regex =
    /(?<comment><!--[\s\S]*?(?:-->|$))|(?<tag><\/?[\w:.-]+|\/?>)|(?<attr>[\w:.-]+(?==))|(?<string>"[^"]*"?|'[^']*'?)|(?<punct>=)|(?<text>[^<"'=\s]+)/gy;
  let index = 0;

  while (index < source.length) {
    regex.lastIndex = index;
    const match = regex.exec(source);
    if (!match) {
      const next = skipUnmatched(source, index);
      pushToken(tokens, source.slice(index, next), "plain");
      index = next;
      continue;
    }

    const groups = match.groups!;
    let kind: TokenKind = "plain";
    if (groups.comment !== undefined) kind = "comment";
    else if (groups.tag !== undefined) kind = "type";
    else if (groups.attr !== undefined) kind = "function";
    else if (groups.string !== undefined) {
      // Only quoting after `=` is an attribute value; an apostrophe in prose
      // must stay plain text.
      kind = previousMeaningfulChar(source, match.index) === "=" ? "string" : "plain";
    } else if (groups.punct !== undefined) kind = "punct";

    pushToken(tokens, match[0], kind);
    index = regex.lastIndex;
  }

  return tokens;
}

function previousMeaningfulChar(source: string, index: number): string {
  for (let at = index - 1; at >= 0; at -= 1) {
    if (!/\s/.test(source[at])) return source[at];
  }
  return "";
}

/** Merges runs of the same kind so the DOM stays small. */
function pushToken(tokens: Token[], text: string, kind: TokenKind): void {
  if (text.length === 0) return;
  const last = tokens[tokens.length - 1];
  if (last && last.kind === kind) last.text += text;
  else tokens.push({ text, kind });
}
