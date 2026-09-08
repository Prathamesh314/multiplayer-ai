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

/** A chat message, delivered the moment it is stored. */
export type MessageCreatedEvent = {
  type: "message.created";
  message: {
    id: string;
    userId: string;
    userName: string;
    handle: string;
    body: string;
    createdAt: number;
  };
  at: number;
};

export type MembersChangedEvent = {
  type: "members.changed";
  at: number;
};

/**
 * One person's role in this room may have changed — promoted, demoted, or their
 * access revoked entirely. Carries only the affected user's id: others ignore
 * it, and the named user re-reads their own role through the authorised route
 * rather than trusting a role pushed over the wire.
 */
export type RoleChangedEvent = {
  type: "role.changed";
  userId: string;
  at: number;
};

/** An agent run opened in this room — tells everyone a new run exists to watch. */
export type RunStartedEvent = {
  type: "run.started";
  runId: string;
  startedBy: string;
  startedByName: string;
  agentId: string;
  at: number;
};

/**
 * A live chunk of a run's output. Unlike a stored turn this is not durable — it
 * is the tail a watcher sees as it happens; the consolidated turn is what they
 * get on reload. Carries text because a run's output is the point of watching.
 */
export type RunOutputEvent = {
  type: "run.output";
  runId: string;
  stream: "out" | "err";
  chunk: string;
  at: number;
};

/** A stored turn was appended to a run's conversation (prompt, or final output). */
export type RunTurnEvent = {
  type: "run.turn";
  runId: string;
  seq: number;
  role: "user" | "agent" | "system" | "tool";
  authorName: string | null;
  body: string;
  at: number;
};

/** A run reached a terminal state. headSha is the commit it produced, if any. */
export type RunFinishedEvent = {
  type: "run.finished";
  runId: string;
  status: "completed" | "failed" | "cancelled";
  headSha: string | null;
  at: number;
};

export type SessionEvent =
  | FileSavedEvent
  | FileEditingEvent
  | MessageCreatedEvent
  | MembersChangedEvent
  | RoleChangedEvent
  | RunStartedEvent
  | RunOutputEvent
  | RunTurnEvent
  | RunFinishedEvent;

export type EventHandler = (event: SessionEvent) => void;

export type EventBus = {
  publish(sessionId: string, event: SessionEvent): Promise<void>;
  /** Resolves to the unsubscribe function. */
  subscribe(sessionId: string, handler: EventHandler): Promise<() => Promise<void>>;
  close(): Promise<void>;
};

export const channelFor = (sessionId: string) => `session:${sessionId}:events`;
