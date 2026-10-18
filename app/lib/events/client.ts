import { currentTabId } from "../tab-id";
import { sharedStream } from "./shared-client";
import type {
  FileEditingEvent,
  FileSavedEvent,
  MessageCreatedEvent,
  RoleChangedEvent,
  RunFinishedEvent,
  RunBranchEvent,
  RunOutputEvent,
  RunRenamedEvent,
  RunStartedEvent,
  RunTurnEvent,
  SessionEvent,
} from "./types";

export type SessionStreamOptions = {
  onRunControl?: () => void;
  onRunInputs?: (event: { runId: string }) => void;
  /** An agent asked to use a tool, or a request was answered (refetch the list). */
  onRunPermission?: (event: { runId: string }) => void;
  onRunActivity?: (event: { runId: string }) => void;
  onTasksChanged?: () => void;
  /** Fires for changes made by any *other* tab. */
  onFileSaved?: (event: FileSavedEvent) => void;
  /** Fires while another person types, not when they save. */
  onFileEditing?: (event: FileEditingEvent) => void;
  /** A chat message from anyone, including this account's other tabs. */
  onMessage?: (event: MessageCreatedEvent) => void;
  onMembersChanged?: () => void;
  onReposChanged?: () => void;
  /** This account's role in the room changed — refresh permissions live. */
  onRoleChanged?: (event: RoleChangedEvent) => void;
  /** A new agent run opened in the room. */
  onRunStarted?: (event: RunStartedEvent) => void;
  /** A live output chunk from a run in progress. */
  onRunOutput?: (event: RunOutputEvent) => void;
  /** A stored turn (prompt or consolidated output) appended to a run. */
  onRunTurn?: (event: RunTurnEvent) => void;
  /** A chat was named — automatically on its first turn, or by its driver. */
  onRunRenamed?: (event: RunRenamedEvent) => void;
  /** A run reached a terminal state. */
  onRunFinished?: (event: RunFinishedEvent) => void;
  /** A parallel chat was merged, updated from the room, discarded or reopened. */
  onRunBranch?: (event: RunBranchEvent) => void;
  /** Connection state, for showing whether live updates are actually flowing. */
  onStatus?: (connected: boolean) => void;
};

export type SessionStream = { close: () => void };

/**
 * Subscribes to a session's event stream.
 *
 * `EventSource` handles reconnection itself — including after a laptop wakes or
 * a deploy drops the connection — which is the main reason this is SSE rather
 * than a socket that would need its own backoff.
 */
export function openSessionStream(
  sessionId: string,
  options: SessionStreamOptions,
): SessionStream {
  const tab = currentTabId();
  return sharedStream(`/api/sessions/${encodeURIComponent(sessionId)}/events`, {
    status: options.onStatus,
    event: (_type, data) => {
      const event = data as SessionEvent;
      if (!event || typeof event !== "object") return;
      switch (event.type) {
        case "file.saved": if (!event.originId || event.originId !== tab) options.onFileSaved?.(event); break;
        case "file.editing": if (!event.originId || event.originId !== tab) options.onFileEditing?.(event); break;
        case "message.created": options.onMessage?.(event); break;
        case "members.changed": options.onMembersChanged?.(); break;
        case "repos.changed": options.onReposChanged?.(); break;
        case "role.changed": options.onRoleChanged?.(event); break;
        case "run.control": options.onRunControl?.(); break;
        case "run.started": options.onRunStarted?.(event); break;
        case "run.output": options.onRunOutput?.(event); break;
        case "run.turn": options.onRunTurn?.(event); break;
        case "run.renamed": options.onRunRenamed?.(event); break;
        case "run.finished": options.onRunFinished?.(event); break;
        case "run.branch": options.onRunBranch?.(event); break;
        case "run.inputs": options.onRunInputs?.(event); break;
        case "run.permission": options.onRunPermission?.(event); break;
        case "run.activity": options.onRunActivity?.(event); break;
        case "tasks.changed": options.onTasksChanged?.(); break;
      }
    },
  });
}
