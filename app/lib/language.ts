export type Grammar = "clike" | "hash" | "json" | "css" | "markup" | "plain";

type LanguageSpec = { label: string; grammar: Grammar };

const LANGUAGES: Record<string, LanguageSpec> = {
  ts: { label: "TypeScript", grammar: "clike" },
  mts: { label: "TypeScript", grammar: "clike" },
  cts: { label: "TypeScript", grammar: "clike" },
  tsx: { label: "TypeScript JSX", grammar: "clike" },
  js: { label: "JavaScript", grammar: "clike" },
  mjs: { label: "JavaScript", grammar: "clike" },
  cjs: { label: "JavaScript", grammar: "clike" },
  jsx: { label: "JavaScript JSX", grammar: "clike" },
  java: { label: "Java", grammar: "clike" },
  kt: { label: "Kotlin", grammar: "clike" },
  swift: { label: "Swift", grammar: "clike" },
  go: { label: "Go", grammar: "clike" },
  rs: { label: "Rust", grammar: "clike" },
  c: { label: "C", grammar: "clike" },
  h: { label: "C Header", grammar: "clike" },
  cpp: { label: "C++", grammar: "clike" },
  hpp: { label: "C++ Header", grammar: "clike" },
  cs: { label: "C#", grammar: "clike" },
  php: { label: "PHP", grammar: "clike" },
  scala: { label: "Scala", grammar: "clike" },
  dart: { label: "Dart", grammar: "clike" },
  sql: { label: "SQL", grammar: "clike" },
  py: { label: "Python", grammar: "hash" },
  rb: { label: "Ruby", grammar: "hash" },
  sh: { label: "Shell", grammar: "hash" },
  bash: { label: "Shell", grammar: "hash" },
  zsh: { label: "Shell", grammar: "hash" },
  yml: { label: "YAML", grammar: "hash" },
  yaml: { label: "YAML", grammar: "hash" },
  toml: { label: "TOML", grammar: "hash" },
  json: { label: "JSON", grammar: "json" },
  jsonc: { label: "JSON with Comments", grammar: "json" },
  lock: { label: "Lockfile", grammar: "plain" },
  css: { label: "CSS", grammar: "css" },
  scss: { label: "SCSS", grammar: "css" },
  sass: { label: "Sass", grammar: "css" },
  less: { label: "Less", grammar: "css" },
  html: { label: "HTML", grammar: "markup" },
  htm: { label: "HTML", grammar: "markup" },
  xml: { label: "XML", grammar: "markup" },
  svg: { label: "SVG", grammar: "markup" },
  vue: { label: "Vue", grammar: "markup" },
  svelte: { label: "Svelte", grammar: "markup" },
  md: { label: "Markdown", grammar: "plain" },
  mdx: { label: "MDX", grammar: "plain" },
  txt: { label: "Plain Text", grammar: "plain" },
};

const BY_FILENAME: Record<string, LanguageSpec> = {
  dockerfile: { label: "Dockerfile", grammar: "hash" },
  makefile: { label: "Makefile", grammar: "hash" },
  ".gitignore": { label: "Ignore File", grammar: "hash" },
  ".gitattributes": { label: "Attributes", grammar: "hash" },
  ".env": { label: "Env File", grammar: "hash" },
  ".editorconfig": { label: "EditorConfig", grammar: "hash" },
};

export function extensionOf(name: string): string {
  const dotAt = name.lastIndexOf(".");
  return dotAt > 0 && dotAt < name.length - 1 ? name.slice(dotAt + 1).toLowerCase() : "";
}

export function languageOf(fileName: string): LanguageSpec {
  const base = fileName.toLowerCase();
  return (
    BY_FILENAME[base] ??
    LANGUAGES[extensionOf(base)] ?? { label: "Plain Text", grammar: "plain" }
  );
}
