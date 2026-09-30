/** Immutable Git reads only. Authorization remains in the caller on every request. */
export class GitReadCache {
  private entries = new Map<string, Buffer>();
  private pending = new Map<string, Promise<Buffer | null>>();
  private bytes = 0;
  constructor(private maxBytes = 32 * 1024 * 1024, private maxEntries = 4096, private maxEntryBytes = 1024 * 1024) {}

  async read(key: string, load: () => Promise<Buffer | null>): Promise<Buffer | null> {
    const hit = this.entries.get(key);
    if (hit) {
      this.entries.delete(key); this.entries.set(key, hit);
      return Buffer.from(hit);
    }
    let pending = this.pending.get(key);
    if (!pending) {
      pending = Promise.resolve().then(load).then(value => {
        if (value && value.length <= Math.min(this.maxEntryBytes, this.maxBytes)) {
          const replaced = this.entries.get(key);
          if (replaced) { this.bytes -= replaced.length; this.entries.delete(key); }
          while (this.entries.size && (this.bytes + value.length > this.maxBytes || this.entries.size >= this.maxEntries)) {
            const oldest = this.entries.keys().next().value!;
            this.bytes -= this.entries.get(oldest)!.length; this.entries.delete(oldest);
          }
          this.entries.set(key, Buffer.from(value)); this.bytes += value.length;
        }
        return value;
      });
      // Bound retained in-flight bookkeeping too. Errors are never cached.
      if (this.pending.size < this.maxEntries) this.pending.set(key, pending);
    }
    try { const value = await pending; return value ? Buffer.from(value) : null; }
    finally { if (this.pending.get(key) === pending) this.pending.delete(key); }
  }
}

const state = globalThis as unknown as { __maGitReadCache?: GitReadCache };
export function cachedGitRead(bare: string, sha: string, operation: string, load: () => Promise<Buffer | null>) {
  // Branch names can move. Only full content IDs are safe to retain.
  if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(sha)) return load();
  state.__maGitReadCache ??= new GitReadCache();
  return state.__maGitReadCache.read(JSON.stringify([bare, sha, operation]), load);
}
