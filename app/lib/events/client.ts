import { currentTabId } from "../tab-id";
import type {
  FileEditingEvent,
  FileSavedEvent,
  MessageCreatedEvent,
  RunFinishedEvent,
  RunOutputEvent,
  RunStartedEvent,
  RunTurnEvent,
  SessionEvent,
} from "./types";

export type SessionStreamOptions = {
  /** Fires for changes made by any *other* tab. */
  onFileSaved?: (event: FileSavedEvent) => void;
  /** Fires while another person types, not when they save. */
  onFileEditing?: (event: FileEditingEvent) => void;
  /** A chat message from anyone, including this account's other tabs. */
  onMessage?: (event: MessageCreatedEvent) => void;
  onMembersChanged?: () => void;
  /** A new agent run opened in the room. */
  onRunStarted?: (event: RunStartedEvent) => void;
  /** A live output chunk from a run in progress. */
  onRunOutput?: (event: RunOutputEvent) => void;
  /** A stored turn (prompt or consolidated output) appended to a run. */
  onRunTurn?: (event: RunTurnEvent) => void;
  /** A run reached a terminal state. */
  onRunFinished?: (event: RunFinishedEvent) => void;
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
  const source = new EventSource(`/api/sessions/${encodeURIComponent(sessionId)}/events`);
  const tab = currentTabId();

  source.addEventListener("ready", () => options.onStatus?.(true));

  source.addEventListener("file.saved", (message) => {
    const event = parse(message);
    if (event?.type !== "file.saved") return;
    // Skip our own echo: this tab already has the text it just sent.
    if (event.originId && event.originId === tab) return;
    options.onFileSaved?.(event);
  });

  source.addEventListener("file.editing", (message) => {
    const event = parse(message);
    if (event?.type !== "file.editing") return;
    if (event.originId && event.originId === tab) return;
    options.onFileEditing?.(event);
  });

  // Not filtered by tab: your own message should still land in your other
  // windows, and the sender reconciles by id rather than by suppressing it.
  source.addEventListener("message.created", (message) => {
    const event = parse(message);
    if (event?.type !== "message.created") return;
    options.onMessage?.(event);
  });

  source.addEventListener("members.changed", () => options.onMembersChanged?.());

  source.addEventListener("run.started", (message) => {
    const event = parse(message);
    if (event?.type === "run.started") options.onRunStarted?.(event);
  });

  source.addEventListener("run.output", (message) => {
    const event = parse(message);
    if (event?.type === "run.output") options.onRunOutput?.(event);
  });

  source.addEventListener("run.turn", (message) => {
    const event = parse(message);
    if (event?.type === "run.turn") options.onRunTurn?.(event);
  });

  source.addEventListener("run.finished", (message) => {
    const event = parse(message);
    if (event?.type === "run.finished") options.onRunFinished?.(event);
  });

  source.onopen = () => options.onStatus?.(true);
  source.onerror = () => {
    // EventSource reconnects on its own; this only reports the gap.
    options.onStatus?.(false);
  };

  return {
    close() {
      source.close();
      options.onStatus?.(false);
    },
  };
}

function parse(message: MessageEvent): SessionEvent | null {
  try {
    return JSON.parse(message.data as string) as SessionEvent;
  } catch {
    return null;
  }
}
