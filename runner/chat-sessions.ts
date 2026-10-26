/**
 * Each chat's own session with its AI tool, on this computer: Claude Code's
 * session id, Codex's thread id. The next turn of the chat resumes it, so the
 * agent remembers everything it read, ran and decided in earlier turns, as it
 * would in a terminal. Kept in the runner's data folder (never sent anywhere),
 * keyed by chat; a chat on another computer, or whose session cannot resume,
 * starts a new one with the conversation so far in its prompt.
 */
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

export type ChatSession = { agentId: string; sessionId: string; cwd: string; updatedAt: number };

const MAX_SESSIONS = 1000;

export class ChatSessions {
  private writing: Promise<void> = Promise.resolve();
  constructor(private readonly file: string) {}

  static in(dataDir: string): ChatSessions {
    return new ChatSessions(join(dataDir, "chat-sessions.json"));
  }

  private async read(): Promise<Record<string, ChatSession>> {
    try {
      const value = JSON.parse(await readFile(this.file, "utf8"));
      return value && typeof value === "object" && !Array.isArray(value) ? value : {};
    } catch {
      return {};
    }
  }

  /** The session to resume for this chat, if it ran here with the same tool in the same folder. */
  async get(runId: string, agentId: string, cwd: string): Promise<string | null> {
    const entry = (await this.read())[runId];
    return entry && entry.agentId === agentId && entry.cwd === cwd && typeof entry.sessionId === "string" ? entry.sessionId : null;
  }

  async set(runId: string, session: Omit<ChatSession, "updatedAt">): Promise<void> {
    this.writing = this.writing.then(async () => {
      const all = await this.read();
      all[runId] = { ...session, updatedAt: Date.now() };
      // Only the most recent chats are kept.
      const kept = Object.fromEntries(Object.entries(all).sort(([, a], [, b]) => b.updatedAt - a.updatedAt).slice(0, MAX_SESSIONS));
      await mkdir(dirname(this.file), { recursive: true });
      const temp = `${this.file}.${process.pid}.tmp`;
      await writeFile(temp, JSON.stringify(kept), { mode: 0o600 });
      await rename(temp, this.file);
    }).catch(() => { /* not remembered: the next turn starts a new session */ });
    return this.writing;
  }

  async forget(runId: string): Promise<void> {
    this.writing = this.writing.then(async () => {
      const all = await this.read();
      if (!(runId in all)) return;
      delete all[runId];
      const temp = `${this.file}.${process.pid}.tmp`;
      await writeFile(temp, JSON.stringify(all), { mode: 0o600 });
      await rename(temp, this.file);
    }).catch(() => {});
    return this.writing;
  }
}
