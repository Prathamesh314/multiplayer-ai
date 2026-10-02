import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import { dataRoot } from "../session/paths";

/** Check actual quarantined bytes before Git makes objects/refs durable. Thin
 * packs may acquire missing bases during reception, beyond their wire size. */
export async function receiveBudgetHooks(maxBytes = 159 * 1024 * 1024): Promise<string> {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > 159 * 1024 * 1024) throw new Error("Invalid receive budget.");
  const script = `#!/usr/bin/env python3
import os,stat,sys
root=os.environ.get('GIT_QUARANTINE_PATH')
if root:
 total=0
 for directory,folders,files in os.walk(root,followlinks=False):
  for name in folders+files:
   item=os.lstat(os.path.join(directory,name))
   if stat.S_ISLNK(item.st_mode):
    print('Unsupported symbolic link in Git quarantine.',file=sys.stderr);sys.exit(1)
   if stat.S_ISREG(item.st_mode):total+=item.st_size
   if total>${maxBytes}:
    print('Git objects and indexes exceed the storage allowance for one push. Split the changes into smaller pushes; existing work was preserved.',file=sys.stderr);sys.exit(1)
`;
  const folder = join(dataRoot(), "receive-hooks", createHash("sha256").update(script).digest("hex"));
  await mkdir(folder, { recursive: true, mode: 0o700 });
  const file = join(folder, "pre-receive");
  try {
    if (await readFile(file, "utf8") !== script) throw new Error("Receive hook integrity check failed.");
    return folder;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const temporary = join(folder, `hook-${randomUUID()}.tmp`);
  try {
    await writeFile(temporary, script, { flag: "wx", mode: 0o700 });
    await rename(temporary, file); // Concurrent initializers install identical, complete bytes.
  } finally { await rm(temporary, { force: true }); }
  return folder;
}
