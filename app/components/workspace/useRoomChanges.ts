"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { openSessionStream } from "../../lib/events/client";
import { fetchChanges } from "../../lib/session/remote";
import type { ChangedFile, ChangesResponse } from "../../lib/session/types";

export type RoomChanges = {
  data: ChangesResponse | null;
  error: string | null;
  loading: boolean;
  reload: () => Promise<void>;
  /** Path → its change, for decorating the tree and the editor. */
  byPath: Map<string, ChangedFile>;
  /** Files marked viewed in review; a mark lasts until that file changes again. */
  isViewed: (file: ChangedFile) => boolean;
  viewed: Set<string>;
  toggleViewed: (file: ChangedFile) => void;
};

export const viewedKey = (file: ChangedFile) => `${file.path}\0${file.status}\0${file.added ?? 0}\0${file.removed ?? 0}`;

/**
 * The selected repository's changes since import, kept live: an agent's
 * checkpoints, finished turns and teammates' saves all refresh it, in bursts
 * that coalesce. One source for the file tree, the Changes tab and the editor.
 */
export function useRoomChanges(sessionId: string | undefined, repoId: string | null, commit: string | null | undefined): RoomChanges {
  const [data, setData] = useState<ChangesResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const generation = useRef(0);

  const reload = useCallback(async () => {
    if (!sessionId) return;
    const request = ++generation.current;
    setLoading(true);
    try {
      const next = await fetchChanges(sessionId, repoId);
      if (request === generation.current) { setData(next); setError(null); }
    } catch (cause) {
      // Keep what is shown through a passing failure; say so only when there is nothing.
      if (request === generation.current) setError(cause instanceof Error ? cause.message : "Could not load changes.");
    } finally {
      if (request === generation.current) setLoading(false);
    }
  }, [sessionId, repoId]);

  // A different repository starts over rather than showing the last one's list.
  const [shownFor, setShownFor] = useState(`${sessionId}:${repoId}`);
  if (shownFor !== `${sessionId}:${repoId}`) { setShownFor(`${sessionId}:${repoId}`); setData(null); setError(null); }

  useEffect(() => {
    void Promise.resolve().then(reload);
  }, [commit, reload]);

  useEffect(() => {
    if (!sessionId) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const changed = () => {
      clearTimeout(timer);
      timer = setTimeout(() => { if (!document.hidden) void reload(); }, 600);
    };
    const stream = openSessionStream(sessionId, {
      onRunActivity: changed,
      onRunFinished: changed,
      onRunBranch: changed,
      onFileSaved: changed,
      onStatus: (connected) => { if (connected) changed(); },
    });
    document.addEventListener("visibilitychange", changed);
    return () => { clearTimeout(timer); stream.close(); document.removeEventListener("visibilitychange", changed); };
  }, [sessionId, reload]);

  const byPath = useMemo(() => new Map((data?.changes ?? []).map((file) => [file.path, file])), [data]);
  const [viewed, setViewed] = useState<Set<string>>(() => new Set());
  const toggleViewed = useCallback((file: ChangedFile) => {
    setViewed((previous) => {
      const next = new Set(previous);
      const key = viewedKey(file);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }, []);
  const isViewed = useCallback((file: ChangedFile) => viewed.has(viewedKey(file)), [viewed]);
  return { data, error: data ? null : error, loading, reload, byPath, viewed, isViewed, toggleViewed };
}
