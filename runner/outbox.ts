import { mkdir, readFile, readdir, rename, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { RunnerCompleteRequest } from "../app/api/runner/runs/[runId]/complete/route";
import type { RunnerApi } from "./api";

export async function storeCompletion(dataDir: string, turnId: string, report: RunnerCompleteRequest) {
  const directory = join(dataDir, "outbox");
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const file = join(directory, `${turnId}.json`);
  await writeFile(`${file}.tmp`, JSON.stringify(report), { mode: 0o600 });
  await rename(`${file}.tmp`, file);
}

export async function deliverCompletions(dataDir: string, api: RunnerApi): Promise<void> {
  const directory = join(dataDir, "outbox");
  const files = await readdir(directory).catch(() => []);
  for (const file of files.filter(file => /^[0-9a-f-]{36}\.json$/.test(file))) {
    const path = join(directory, file);
    try {
      const report = JSON.parse(await readFile(path, "utf8")) as RunnerCompleteRequest;
      await api.complete(file.slice(0, -5), report);
      await unlink(path);
    } catch (cause) {
      console.error(`[runner] completion retained for retry (${file}): ${String(cause)}`);
    }
  }
}
