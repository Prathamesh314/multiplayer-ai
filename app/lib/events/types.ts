/**
 * Events broadcast to everyone watching a session.
 *
 * Deliberately thin: an event says *that* something changed and who did it,
 * never what the new contents are. Recipients re-read the file through the
 * normal authorised route, so a broadcast can never hand someone bytes their
 * role would not let them fetch.
 */

export type FileSavedEvent = {
  type: "file.saved";
  path: string;
  headSha: string;
  authorId: string;
  authorName: string;
  /** The tab that caused it, so that tab can ignore its own echo. */
  originId: string | null;
  at: number;
};

/**
 * "Someone is typing in this file", sent while they type rather than when they
 * save. Saves are debounced and committed, so they arrive over a second later —
 * far too slow to show presence inside a file.
 *
 * Deliberately carries no text: it says who and where, never what.
 */
export type FileEditingEvent = {
  type: "file.editing";
  /** Repo-relative path; the file name is the last segment of it. */
  path: string;
  /** 1-based caret position, so the name can be drawn where they actually are. */
  line: number;
  column: number;
  userId: string;
  userName: string;
  originId: string | null;
  at: number;
};

export type MembersChangedEvent = {
  type: "members.changed";
  at: number;
};

export type SessionEvent = FileSavedEvent | FileEditingEvent | MembersChangedEvent;

export type EventHandler = (event: SessionEvent) => void;

export type EventBus = {
  publish(sessionId: string, event: SessionEvent): Promise<void>;
  /** Resolves to the unsubscribe function. */
  subscribe(sessionId: string, handler: EventHandler): Promise<() => Promise<void>>;
  close(): Promise<void>;
};

export const channelFor = (sessionId: string) => `session:${sessionId}:events`;
