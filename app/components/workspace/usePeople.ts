"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { FileEditingEvent, FileSavedEvent } from "../../lib/events/types";
import { fetchMembers } from "../../lib/session/client";
import type { SessionMember } from "../../lib/session/types";

/** How long after their last keystroke someone still counts as "in" a file. */
const EDITING_TTL_MS = 6_000;
/** How often expired badges are swept. */
const SWEEP_MS = 2_000;

export type FilePresence = {
  userId: string;
  name: string;
  /** 1-based caret position inside the file. */
  line: number;
  column: number;
  at: number;
};

export type People = {
  members: SessionMember[];
  /** Repo path → who is typing in it right now. */
  editing: Map<string, FilePresence[]>;
  /** Feed an event in; both hooks are stable, so they never resubscribe. */
  onEditing: (event: FileEditingEvent) => void;
  onSaved: (event: FileSavedEvent) => void;
  refresh: () => void;
  onOnline: (ids: string[]) => void;
};

/**
 * Who is in this session, and who is in each file.
 *
 * Two different clocks: the roster comes from the database and changes rarely,
 * while "typing in this file" is a claim that expires on its own a few seconds
 * after the last keystroke. Nothing needs a goodbye message — a closed laptop
 * simply stops renewing.
 */
export function usePeople(sessionId: string, enabled: boolean): People {
  const [members, setMembers] = useState<SessionMember[]>([]);
  const [editing, setEditing] = useState<Map<string, FilePresence[]>>(() => new Map());
  const [version, setVersion] = useState(0);

  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    fetchMembers(sessionId).then((list) => !cancelled && setMembers(list));
    return () => {
      cancelled = true;
    };
  }, [sessionId, enabled, version]);

  const onEditing = useCallback((event: FileEditingEvent) => {
    setEditing((previous) => {
      const next = new Map(previous);
      const others = (next.get(event.path) ?? []).filter((p) => p.userId !== event.userId);
      next.set(event.path, [
        ...others,
        {
          userId: event.userId,
          name: event.userName,
          line: event.line,
          column: event.column,
          at: Date.now(),
        },
      ]);
      return next;
    });
  }, []);

  // A save means they stopped typing, so the badge goes immediately rather
  // than lingering for the rest of the TTL.
  const onSaved = useCallback((event: FileSavedEvent) => {
    setEditing((previous) => {
      const current = previous.get(event.path);
      if (!current) return previous;
      const remaining = current.filter((p) => p.userId !== event.authorId);
      const next = new Map(previous);
      if (remaining.length > 0) next.set(event.path, remaining);
      else next.delete(event.path);
      return next;
    });
  }, []);

  const editingRef = useRef(editing);
  useEffect(() => {
    editingRef.current = editing;
  }, [editing]);

  useEffect(() => {
    if (!enabled) return;
    const timer = setInterval(() => {
      const cutoff = Date.now() - EDITING_TTL_MS;
      let changed = false;
      const next = new Map<string, FilePresence[]>();

      for (const [path, people] of editingRef.current) {
        const alive = people.filter((person) => person.at > cutoff);
        if (alive.length !== people.length) changed = true;
        if (alive.length > 0) next.set(path, alive);
      }
      if (changed) setEditing(next);
    }, SWEEP_MS);

    return () => clearInterval(timer);
  }, [enabled]);

  const onOnline = useCallback((ids: string[]) => { const online = new Set(ids); setMembers(previous => previous.map(member => ({ ...member, online: online.has(member.userId) }))); }, []);

  const refresh = useCallback(() => setVersion((n) => n + 1), []);

  return useMemo(
    () => ({ members, editing, onEditing, onSaved, refresh, onOnline }),
    [members, editing, onEditing, onSaved, refresh, onOnline],
  );
}
