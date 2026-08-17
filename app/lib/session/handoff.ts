import type { PickedSource } from "../folder";

/**
 * Carries a folder picked in the create dialog through to the session that is
 * about to open. Navigation is client-side, so a module-level map survives it —
 * and directory handles cannot be serialised into a URL anyway.
 */
const pending = new Map<string, PickedSource>();

export function stashFolder(sessionId: string, source: PickedSource): void {
  pending.set(sessionId, source);
}

/** Reads and clears, so a reload does not re-scan a stale pick. */
export function takeFolder(sessionId: string): PickedSource | null {
  const source = pending.get(sessionId) ?? null;
  pending.delete(sessionId);
  return source;
}
