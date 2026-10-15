import { mkdirSync, writeFileSync, renameSync, readdirSync, readFileSync, unlinkSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import type { AiRunEvent } from "../app/lib/ai/run-events";
import type { RunnerApi } from "./api";

/** Each small batch reaches disk before the network. Retries survive runner restarts. */
export class ActivityOutbox {
  private readonly directory: string;
  private sending: Promise<void> | null = null;
  private pending = false;
  constructor(dataDir: string, server: string, token: string) {
    this.directory = join(dataDir, "activity-outbox", createHash("sha256").update(server + "\0" + token).digest("hex"));
    mkdirSync(this.directory, { recursive: true, mode: 0o700 });
  }
  store(turnId: string, sequence: number, events: AiRunEvent[]) {
    if (!/^[0-9a-f-]{36}$/.test(turnId) || !Number.isSafeInteger(sequence)) throw new Error("Invalid activity batch identity.");
    const path = join(this.directory, `${turnId}.${String(sequence).padStart(8, "0")}.json`);
    writeFileSync(path + ".tmp", JSON.stringify({ turnId, sequence, events }), { mode: 0o600, flush: true });
    renameSync(path + ".tmp", path);
  }
  /**
   * One drain at a time. A call during a drain schedules another pass, so the
   * returned promise always covers batches stored before the call — parallel
   * turns finishing together each see their final batch delivered.
   */
  deliver(api: RunnerApi): Promise<void> {
    this.pending = true;
    this.sending ??= (async () => {
      while (this.pending) { this.pending = false; await this.drain(api); }
    })().finally(() => { this.sending = null; });
    return this.sending;
  }
  private async drain(api: RunnerApi) {
    const failed = new Set<string>();
    for (const file of readdirSync(this.directory).filter(name => /^[0-9a-f-]{36}\.\d{8}\.json$/.test(name)).sort()) {
      const turnId = file.slice(0, 36); if (failed.has(turnId)) continue;
      try {
        const entry = JSON.parse(readFileSync(join(this.directory, file), "utf8"));
        await api.postEvents(entry.turnId, entry.events, entry.sequence);
        unlinkSync(join(this.directory, file));
      } catch (cause) { failed.add(turnId); console.error(`[runner] activity retained for retry: ${String(cause)}`); }
    }
  }
}
