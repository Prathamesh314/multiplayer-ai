"use client";

import { useCallback, useEffect, useState } from "react";
import type { AgentRun } from "../../lib/ai/runs";
import { listRuns } from "../../lib/ai/runs-client";
import { openSessionStream } from "../../lib/events/client";

/**
 * The room's agent runs, kept live. One place owns the list so the sidebar
 * (which browses runs by person) and the chat (which shows one) never drift.
 * Realtime: a run appearing or finishing anywhere in the room refreshes it;
 * the streaming output of a single run is followed by the chat itself.
 */
export function useRoomRuns(sessionId: string): { runs: AgentRun[]; refresh: () => void } {
  const [runs, setRuns] = useState<AgentRun[]>([]);

  const refresh = useCallback(() => {
    void listRuns(sessionId)
      .then(setRuns)
      .catch(() => {});
  }, [sessionId]);

  useEffect(() => {
    refresh();
    const stream = openSessionStream(sessionId, {
      onRunStarted: refresh,
      onRunFinished: refresh,
      onRunControl: refresh,
      onRunTurn: refresh,
      // A parallel chat was merged, updated, discarded or reopened.
      onRunBranch: refresh,
      // Patched in place rather than refetched: the sidebar row animates the
      // change, and a full reload would replace the row and lose the animation.
      onRunRenamed: event => setRuns(previous =>
        previous.map(run => (run.id === event.runId ? { ...run, title: event.title } : run))),
      onStatus: connected => { if (connected) refresh(); },
    });
    return () => stream.close();
  }, [sessionId, refresh]);

  return { runs, refresh };
}
