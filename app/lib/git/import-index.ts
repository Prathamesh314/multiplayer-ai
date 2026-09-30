import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { objectGit } from "./objects";

/** Preserve Git's ignore semantics while materializing only the ignore files. */
export async function filterImportIndex(bare: string, index: Partial<NodeJS.ProcessEnv>) {
  const paths = (await objectGit(bare, ["ls-files", "-z"], undefined, index)).toString().split("\0").filter(Boolean);
  if (!paths.length) return;
  const scratch = await mkdtemp(join(bare, ".import-ignore-"));
  try {
    for (const path of paths.filter(path => path === ".gitignore" || path.endsWith("/.gitignore"))) {
      const destination = join(scratch, path);
      await mkdir(dirname(destination), { recursive: true });
      await writeFile(destination, await objectGit(bare, ["show", `:${path}`], undefined, index));
    }
    let ignored: Buffer;
    try {
      ignored = await objectGit(scratch, ["--git-dir", bare, "--work-tree", scratch, "-c", "core.bare=false", "check-ignore", "--no-index", "-z", "--stdin"], paths.join("\0") + "\0", index);
    } catch (cause) {
      if ((cause as { code?: number }).code === 1) return; // No matches.
      throw cause;
    }
    if (ignored.length) await objectGit(scratch, ["--git-dir", bare, "--work-tree", scratch, "-c", "core.bare=false", "update-index", "--force-remove", "-z", "--stdin"], ignored, index);
  } finally { await rm(scratch, { recursive: true, force: true }); }
}
