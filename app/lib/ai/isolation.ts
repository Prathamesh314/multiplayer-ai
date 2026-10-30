/**
 * Parallel ("isolated") chats.
 *
 * A shared chat works directly on the room branch, so a person runs one at a
 * time per room and their turns promote with a compare-and-swap on the room
 * head. An isolated chat works on its own branch (`chat/<run id>`, see
 * session/repo.ts) forked from the room head: its turns start from and promote
 * onto that branch, several can run at once, and its work reaches the room
 * branch only through an explicit merge.
 */
export type RunIsolation = "shared" | "isolated";
export type MergeState = "open" | "merged" | "discarded";
