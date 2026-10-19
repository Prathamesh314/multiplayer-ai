/*
 * File icons that say what a file is at a glance, in the spirit of VS Code's
 * Material and Seti themes: a tinted language badge for source files, and a
 * glyph for data, media, documents and config. Shared by the file tree, the
 * Changes tab, editor tabs and the review page.
 */

type Glyph = "sheet" | "image" | "doc" | "braces" | "lock" | "gear" | "terminal" | "archive" | "git" | "file" | "video" | "audio";
type Kind = { badge?: string; glyph?: Glyph; color: string };

const BADGE = (badge: string, color: string): Kind => ({ badge, color });
const GLYPH = (glyph: Glyph, color: string): Kind => ({ glyph, color });

const BY_EXTENSION: Record<string, Kind> = {
  ts: BADGE("TS", "text-[#3178c6] dark:text-[#4d9bea]"), mts: BADGE("TS", "text-[#3178c6] dark:text-[#4d9bea]"), cts: BADGE("TS", "text-[#3178c6] dark:text-[#4d9bea]"),
  tsx: BADGE("TSX", "text-[#3178c6] dark:text-[#4d9bea]"), jsx: BADGE("JSX", "text-[#d4a72c] dark:text-[#f1d14c]"),
  js: BADGE("JS", "text-[#d4a72c] dark:text-[#f1d14c]"), mjs: BADGE("JS", "text-[#d4a72c] dark:text-[#f1d14c]"), cjs: BADGE("JS", "text-[#d4a72c] dark:text-[#f1d14c]"),
  py: BADGE("PY", "text-[#3572a5] dark:text-[#5aa0d8]"), ipynb: BADGE("NB", "text-[#f37626]"),
  go: BADGE("GO", "text-[#00add8]"), rs: BADGE("RS", "text-[#dea584]"), java: BADGE("JV", "text-[#e76f00]"), kt: BADGE("KT", "text-[#a97bff]"),
  rb: BADGE("RB", "text-[#cc342d] dark:text-[#ff6b61]"), php: BADGE("PHP", "text-[#777bb4] dark:text-[#9da1e0]"), swift: BADGE("SW", "text-[#f05138]"),
  c: BADGE("C", "text-[#5c6bc0] dark:text-[#8c9eff]"), h: BADGE("H", "text-[#5c6bc0] dark:text-[#8c9eff]"), cpp: BADGE("C++", "text-[#00599c] dark:text-[#4fa3e0]"),
  cc: BADGE("C++", "text-[#00599c] dark:text-[#4fa3e0]"), hpp: BADGE("H++", "text-[#00599c] dark:text-[#4fa3e0]"), cs: BADGE("C#", "text-[#68217a] dark:text-[#b77fd1]"),
  html: BADGE("<>", "text-[#e34c26] dark:text-[#ff7a52]"), htm: BADGE("<>", "text-[#e34c26] dark:text-[#ff7a52]"), vue: BADGE("V", "text-[#41b883]"), svelte: BADGE("S", "text-[#ff3e00]"),
  css: BADGE("#", "text-[#663399] dark:text-[#a77bdc]"), scss: BADGE("#", "text-[#cd6799]"), sass: BADGE("#", "text-[#cd6799]"), less: BADGE("#", "text-[#1d365d] dark:text-[#6f8fbf]"),
  md: BADGE("MD", "text-[#519aba]"), mdx: BADGE("MDX", "text-[#519aba]"), sql: BADGE("SQL", "text-[#e38c00]"), lua: BADGE("LUA", "text-[#000080] dark:text-[#7d7dff]"),
  sh: GLYPH("terminal", "text-[#4eaa25]"), bash: GLYPH("terminal", "text-[#4eaa25]"), zsh: GLYPH("terminal", "text-[#4eaa25]"), ps1: GLYPH("terminal", "text-[#5391fe]"),
  json: GLYPH("braces", "text-[#cbb026] dark:text-[#e8cd4a]"), jsonc: GLYPH("braces", "text-[#cbb026] dark:text-[#e8cd4a]"),
  yml: GLYPH("gear", "text-[#cb171e] dark:text-[#ff6b6b]"), yaml: GLYPH("gear", "text-[#cb171e] dark:text-[#ff6b6b]"), toml: GLYPH("gear", "text-[#9c4221] dark:text-[#e58a5c]"),
  ini: GLYPH("gear", "text-vs-muted"), env: GLYPH("gear", "text-[#ecd53f]"), xml: BADGE("<>", "text-[#f1662a]"),
  csv: GLYPH("sheet", "text-[#1d9e60] dark:text-[#34c47c]"), tsv: GLYPH("sheet", "text-[#1d9e60] dark:text-[#34c47c]"),
  xlsx: GLYPH("sheet", "text-[#107c41] dark:text-[#2fb36b]"), xls: GLYPH("sheet", "text-[#107c41] dark:text-[#2fb36b]"), numbers: GLYPH("sheet", "text-[#1d9e60]"),
  png: GLYPH("image", "text-[#a074c4] dark:text-[#c39be6]"), jpg: GLYPH("image", "text-[#a074c4] dark:text-[#c39be6]"), jpeg: GLYPH("image", "text-[#a074c4] dark:text-[#c39be6]"),
  gif: GLYPH("image", "text-[#a074c4] dark:text-[#c39be6]"), webp: GLYPH("image", "text-[#a074c4] dark:text-[#c39be6]"), svg: GLYPH("image", "text-[#ffb13b]"), ico: GLYPH("image", "text-[#a074c4] dark:text-[#c39be6]"),
  pdf: BADGE("PDF", "text-[#e5252a] dark:text-[#ff5a5f]"), doc: GLYPH("doc", "text-[#2b579a] dark:text-[#5b8bd6]"), docx: GLYPH("doc", "text-[#2b579a] dark:text-[#5b8bd6]"),
  txt: GLYPH("doc", "text-vs-muted"), rtf: GLYPH("doc", "text-vs-muted"), log: GLYPH("doc", "text-vs-muted"),
  zip: GLYPH("archive", "text-[#b07219]"), gz: GLYPH("archive", "text-[#b07219]"), tar: GLYPH("archive", "text-[#b07219]"), tgz: GLYPH("archive", "text-[#b07219]"),
  mp4: GLYPH("video", "text-[#e44d26]"), mov: GLYPH("video", "text-[#e44d26]"), webm: GLYPH("video", "text-[#e44d26]"),
  mp3: GLYPH("audio", "text-[#ef6c00]"), wav: GLYPH("audio", "text-[#ef6c00]"), lock: GLYPH("lock", "text-vs-muted"),
};

const BY_NAME: Record<string, Kind> = {
  "package.json": BADGE("npm", "text-[#cb3837] dark:text-[#ff5c5b]"), "package-lock.json": GLYPH("lock", "text-[#cb3837] dark:text-[#ff5c5b]"),
  "yarn.lock": GLYPH("lock", "text-[#2c8ebb]"), "pnpm-lock.yaml": GLYPH("lock", "text-[#f9ad00]"), "bun.lockb": GLYPH("lock", "text-[#fbf0df]"),
  "dockerfile": BADGE("DKR", "text-[#2496ed]"), "makefile": GLYPH("gear", "text-[#6d8086]"), ".gitignore": GLYPH("git", "text-[#f05032]"),
  ".gitattributes": GLYPH("git", "text-[#f05032]"), ".gitmodules": GLYPH("git", "text-[#f05032]"), "license": GLYPH("doc", "text-[#d0bf41]"),
  "readme.md": BADGE("i", "text-[#519aba]"), ".env": GLYPH("gear", "text-[#ecd53f]"), ".env.local": GLYPH("gear", "text-[#ecd53f]"),
  ".editorconfig": GLYPH("gear", "text-vs-muted"), "tsconfig.json": BADGE("TS", "text-[#3178c6] dark:text-[#4d9bea]"),
};

const FALLBACK: Kind = GLYPH("file", "text-vs-muted");

export function fileKind(name: string): Kind {
  const lower = name.toLowerCase();
  if (BY_NAME[lower]) return BY_NAME[lower];
  if (lower.startsWith(".env")) return BY_NAME[".env"];
  const dot = lower.lastIndexOf(".");
  return (dot > 0 && BY_EXTENSION[lower.slice(dot + 1)]) || FALLBACK;
}

/** A 16×16 icon for `name` (a file name or path). */
export function FileTypeIcon({ name, className = "h-4 w-4" }: { name: string; className?: string }) {
  const kind = fileKind(name.slice(name.lastIndexOf("/") + 1));
  if (kind.badge) {
    const text = kind.badge;
    const size = text.length >= 3 ? 5.6 : text.length === 2 ? 7 : 9;
    return (
      <svg viewBox="0 0 16 16" aria-hidden className={`shrink-0 ${kind.color} ${className}`}>
        <rect x="0.75" y="1.75" width="14.5" height="12.5" rx="3" fill="currentColor" opacity="0.16" />
        <rect x="0.75" y="1.75" width="14.5" height="12.5" rx="3" fill="none" stroke="currentColor" strokeOpacity="0.45" strokeWidth="0.75" />
        <text x="8" y="8.25" textAnchor="middle" dominantBaseline="central" fontSize={size} fontWeight="800" fill="currentColor" fontFamily="ui-sans-serif, system-ui, sans-serif" letterSpacing="-0.2">{text}</text>
      </svg>
    );
  }
  return (
    <svg viewBox="0 0 16 16" aria-hidden fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" className={`shrink-0 ${kind.color} ${className}`}>
      {GLYPHS[kind.glyph ?? "file"]}
    </svg>
  );
}

const PAGE = <path d="M4 1.75h5.25L12.5 5v9.25H4z" fill="currentColor" fillOpacity="0.12" />;
const GLYPHS: Record<Glyph, React.ReactNode> = {
  file: <>{PAGE}<path d="M9.25 1.75V5h3.25" /></>,
  doc: <>{PAGE}<path d="M9.25 1.75V5h3.25M6 8h4.5M6 10.25h4.5M6 12.25h2.75" /></>,
  sheet: <><rect x="1.75" y="2.25" width="12.5" height="11.5" rx="2" fill="currentColor" fillOpacity="0.14" /><path d="M1.75 6h12.5M1.75 9.75h12.5M6 2.25v11.5" /></>,
  image: <><rect x="1.75" y="2.25" width="12.5" height="11.5" rx="2" fill="currentColor" fillOpacity="0.14" /><circle cx="5.5" cy="6" r="1.25" /><path d="m2 12 3.75-3.5L8.5 11l2-2 3.5 3.25" /></>,
  braces: <path d="M5.5 2.5c-1.5 0-2 .6-2 2v1.75c0 .9-.5 1.5-1.5 1.75 1 .25 1.5.85 1.5 1.75v1.75c0 1.4.5 2 2 2M10.5 2.5c1.5 0 2 .6 2 2v1.75c0 .9.5 1.5 1.5 1.75-1 .25-1.5.85-1.5 1.75v1.75c0 1.4-.5 2-2 2" strokeWidth="1.5" />,
  gear: <><circle cx="8" cy="8" r="2.25" /><path d="M8 1.75v1.5M8 12.75v1.5M14.25 8h-1.5M3.25 8h-1.5M12.4 3.6l-1.05 1.05M4.65 11.35 3.6 12.4M12.4 12.4l-1.05-1.05M4.65 4.65 3.6 3.6" strokeWidth="1.5" /></>,
  terminal: <><rect x="1.75" y="2.25" width="12.5" height="11.5" rx="2" fill="currentColor" fillOpacity="0.14" /><path d="m4.5 6 2.25 2-2.25 2M8.5 10.5h3" strokeWidth="1.5" /></>,
  lock: <><rect x="3" y="7" width="10" height="7" rx="1.75" fill="currentColor" fillOpacity="0.14" /><path d="M5.25 7V5.25a2.75 2.75 0 0 1 5.5 0V7" /></>,
  archive: <><rect x="2" y="2.25" width="12" height="11.5" rx="2" fill="currentColor" fillOpacity="0.14" /><path d="M8 2.25v2M8 5.5v1M8 7.75v1" strokeWidth="1.6" /><rect x="6.75" y="9.25" width="2.5" height="2.5" rx=".5" /></>,
  git: <><path d="M8 1.5 14.5 8 8 14.5 1.5 8z" fill="currentColor" fillOpacity="0.16" /><circle cx="8" cy="5.5" r=".9" fill="currentColor" /><circle cx="8" cy="10.5" r=".9" fill="currentColor" /><path d="M8 6.4v3.2M8.6 6.1l2 2" /></>,
  video: <><rect x="1.75" y="3.25" width="9" height="9.5" rx="2" fill="currentColor" fillOpacity="0.14" /><path d="m10.75 6.5 3.5-2v7l-3.5-2" /></>,
  audio: <><path d="M6 11.5V3.5l7-1.5v8" /><circle cx="4.5" cy="11.5" r="1.75" fill="currentColor" fillOpacity="0.2" /><circle cx="11.5" cy="10" r="1.75" fill="currentColor" fillOpacity="0.2" /></>,
};
