/** Tracked dependencies/build products add noise and often dwarf the source. */
const IGNORED_DIRS = new Set([
  "node_modules", ".next", ".git", "dist", "build", "out", "coverage",
  "vendor", "target", "__pycache__", ".venv", ".idea", ".vscode",
]);
const IGNORED_FILES = new Set([
  "package-lock.json", "yarn.lock", "pnpm-lock.yaml", "cargo.lock",
  "poetry.lock", "gemfile.lock", "composer.lock", "uv.lock",
]);

export function isIndexablePath(path: string): boolean {
  const segments = path.toLowerCase().split("/");
  return !segments.some((segment) => IGNORED_DIRS.has(segment)) &&
    !IGNORED_FILES.has(segments.at(-1)!);
}
