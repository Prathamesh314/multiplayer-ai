import { currentTabId } from "../tab-id";
import type { FileEditingEvent, FileSavedEvent, SessionEvent } from "./types";

export type SessionStreamOptions = {
  /** Fires for changes made by any *other* tab. */
  onFileSaved?: (event: FileSavedEvent) => void;
  /** Fires while another person types, not when they save. */
  onFileEditing?: (event: FileEditingEvent) => void;
  onMembersChanged?: () => void;
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

  source.addEventListener("members.changed", () => options.onMembersChanged?.());

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
