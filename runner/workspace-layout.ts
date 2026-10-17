import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, readdir, realpath, rename, writeFile } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

const hash = (value: string) => createHash("sha256").update(value).digest("hex");

/** Safe on Windows as well as POSIX; names are labels, never filesystem paths. */
export function workspaceSlug(value: string | undefined, fallback: string): string {
  const slug = (value ?? "").normalize("NFKD").replace(/[\u0300-\u036f]/g, "")
    .toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 32).replace(/-+$/g, "");
  return slug || fallback;
}

const WINDOWS_RESERVED = /^(con|prn|aux|nul|com\d|lpt\d)$/;
/**
 * A worktree's readable name, used for both its folder and its local branch
 * (as Conductor does): the room's or chat's name, never an ID. Callers make
 * it unique within the repository.
 */
export function readableName(value: string | undefined, fallback: string): string {
  const slug = workspaceSlug(value, fallback);
  return WINDOWS_RESERVED.test(slug) ? `${slug}-work` : slug;
}

export type WorkspaceLocation = { workspaceRoot: string; relativePath: string };

export function locationPath(location: WorkspaceLocation): string {
  // Exactly two generated components: the repository folder (its ID keeps
  // separate installations apart) and the worktree's readable name. Older
  // worktree folders end in --<id>; both are plain slugs.
  if (!isAbsolute(location.workspaceRoot) || !/^[a-z0-9-]+--[a-f0-9]{12}\/[a-z0-9][a-z0-9-]{0,79}$/.test(location.relativePath)) {
    throw new Error("Invalid workspace location metadata. Existing files were preserved.");
  }
  return resolve(location.workspaceRoot, ...location.relativePath.split("/"));
}

export async function writeWorkspaceMetadata(path: string, value: unknown): Promise<void> {
  const temporary = `${path}.${randomUUID()}.tmp`;
  await writeFile(temporary, JSON.stringify(value, null, 2) + "\n", { mode: 0o600 });
  await rename(temporary, path);
}

/** Called under the cache lock, so every room uses the same repository folder. */
export async function allocateWorkspaceLocation(input: {
  workspacesDir: string; metadataRoot: string; cacheKey: string; repoRef: string;
  repositoryName?: string;
  /** Picks the worktree's folder name inside the repository folder (see readableName). */
  chooseName: (repositoryFolder: string) => Promise<string>;
}): Promise<WorkspaceLocation> {
  await mkdir(input.workspacesDir, { recursive: true, mode: 0o700 });
  const workspaceRoot = await realpath(input.workspacesDir);
  const directory = join(input.metadataRoot, "layouts");
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const manifest = join(directory, `${input.cacheKey}.json`);
  let repositoryFolder: string;
  try {
    ({ repositoryFolder } = JSON.parse(await readFile(manifest, "utf8")));
    if (typeof repositoryFolder !== "string" || !/^[a-z0-9-]+--[a-f0-9]{12}$/.test(repositoryFolder)) throw new Error("Invalid repository folder metadata. Files were preserved.");
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code !== "ENOENT") throw cause;
    // Include the local cache scope: separate users, servers and installations
    // must never claim the same visible checkout, even if names are identical.
    repositoryFolder = `${workspaceSlug(input.repositoryName, "repository")}--${hash(`${input.metadataRoot}\0${input.cacheKey}`).slice(0, 12)}`;
    await writeWorkspaceMetadata(manifest, { repositoryFolder });
  }
  return { workspaceRoot, relativePath: `${repositoryFolder}/${await input.chooseName(join(workspaceRoot, repositoryFolder))}` };
}

/** Refuse symlinked generated parents instead of writing through them. */
export async function prepareWorkspaceParent(location: WorkspaceLocation): Promise<void> {
  const work = locationPath(location);
  await mkdir(location.workspaceRoot, { recursive: true, mode: 0o700 });
  if (await realpath(location.workspaceRoot) !== resolve(location.workspaceRoot)) throw new Error("Workspace root was redirected. Files were preserved.");
  const parent = resolve(work, "..");
  const suffix = relative(location.workspaceRoot, parent);
  if (suffix.startsWith(`..${sep}`) || isAbsolute(suffix)) throw new Error("Workspace path escaped its root.");
  try { await mkdir(parent, { mode: 0o700 }); }
  catch (cause) { if ((cause as NodeJS.ErrnoException).code !== "EEXIST") throw cause; }
  const info = await lstat(parent);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error(`Workspace parent is not an ordinary directory: ${parent}. Files were preserved.`);
}

export async function listLocalWorkspaces(dataDir: string) {
  const root = resolve(dataDir, "workspaces-v1");
  const result: { repository: string; room: string; chat?: string; repoRef: string; path: string }[] = [];
  let scopes;
  try { scopes = await readdir(root, { withFileTypes: true }); }
  catch (cause) { if ((cause as NodeJS.ErrnoException).code === "ENOENT") return result; throw cause; }
  for (const scope of scopes) {
    if (!scope.isDirectory() || !/^[a-f0-9]{64}$/.test(scope.name)) continue;
    const bindings = join(root, scope.name, "bindings");
    let files: string[];
    try { files = await readdir(bindings); }
    catch (cause) { if ((cause as NodeJS.ErrnoException).code === "ENOENT") continue; throw cause; }
    for (const file of files) {
      if (!/^[a-f0-9]{64}\.json$/.test(file)) continue;
      const binding = JSON.parse(await readFile(join(bindings, file), "utf8"));
      if (binding.version !== 1 || typeof binding.repoRef !== "string") throw new Error(`Invalid workspace binding: ${file}`);
      result.push({ repository: binding.repositoryName || binding.repoRef, room: binding.roomName || binding.sessionId || binding.repoRef,
        ...(binding.chatRunId ? { chat: binding.chatName || binding.chatRunId } : {}), repoRef: binding.repoRef, path: binding.location ? locationPath(binding.location) : join(root, scope.name, "work", file.slice(0, -5)) });
    }
  }
  return result;
}
