import { queryOne } from "../db/client";
import type { SessionEvent } from "../events/types";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Which room events one member may receive: nothing about a repository that
 * is private to someone else, or about the chats in it (their live output
 * included). Answers are remembered until the room's repositories change.
 */
export function roomEventVisibility(userId: string) {
  const repos = new Map<string, Promise<boolean>>(), runs = new Map<string, Promise<boolean>>();
  const ask = (cache: Map<string, Promise<boolean>>, key: string, sql: string) => {
    let answer = cache.get(key);
    if (!answer) {
      answer = queryOne<{ hidden: boolean }>(sql, [key, userId]).then((row) => row?.hidden === true);
      cache.set(key, answer);
    }
    return answer;
  };
  return {
    reset() { repos.clear(); runs.clear(); },
    async hidden(event: SessionEvent): Promise<boolean> {
      // Carries no content, and tells everyone to reload which repositories they may see.
      if (event.type === "repos.changed") return false;
      const { repoId, runId } = event as { repoId?: unknown; runId?: unknown };
      if (typeof repoId === "string" && repoId && await ask(repos, repoId, "SELECT room_repo_hidden($1, $2) AS hidden")) return true;
      if (typeof runId === "string" && UUID.test(runId) && await ask(runs, runId, "SELECT agent_run_hidden($1, $2) AS hidden")) return true;
      return false;
    },
  };
}
