"use client";

/*
 * Everything waiting for you, in one card: handoffs to accept, tasks assigned
 * to you, and collaboration requests (access, feedback, reviews), with a tab
 * for each and All. Every list stays mounted, so the counts and live updates
 * keep working whichever tab is open.
 */

import { useState } from "react";
import { TaskPanel } from "../tasks/TaskPanel";
import { CollaborationInbox } from "../collaboration/CollaborationControls";
import { HandoffInbox, type useHandoffInbox } from "../collaboration/HandoffInbox";

type Tab = "all" | "tasks" | "handoffs" | "collaboration";

export function ActionQueue({ userId, handoffs }: { userId: string; handoffs: ReturnType<typeof useHandoffInbox> }) {
  const [tab, setTab] = useState<Tab>("all");
  const [tasks, setTasks] = useState<number | null>(null);
  const [collaboration, setCollaboration] = useState<number | null>(null);
  const received = handoffs.data ? handoffs.data.received.length : null;
  const sent = handoffs.data?.sent.length ?? 0;
  const loaded = tasks !== null && collaboration !== null && received !== null;
  const total = (tasks ?? 0) + (collaboration ?? 0) + (received ?? 0);
  const tabs: { id: Tab; label: string; count: number | null }[] = [
    { id: "all", label: "Action queue", count: loaded ? total : null },
    { id: "tasks", label: "My tasks", count: tasks },
    { id: "handoffs", label: "Handoffs", count: received },
    { id: "collaboration", label: "Collaboration", count: collaboration },
  ];
  const all = tab === "all";

  return (
    <section aria-label="Action queue" className="mt-5 overflow-hidden rounded-2xl border border-vs-border bg-vs-panel">
      <div role="tablist" aria-label="What needs you" className="vs-scroll flex items-center gap-1 overflow-x-auto border-b border-vs-border bg-vs-editor/60 px-3 py-2">
        {tabs.map((item) => (
          <button key={item.id} type="button" role="tab" aria-selected={tab === item.id} onClick={() => setTab(item.id)}
            className={`flex shrink-0 items-center gap-1.5 rounded-lg px-3 py-1.5 text-[12.5px] font-medium transition ${tab === item.id ? "bg-vs-active text-vs-fg" : "text-vs-muted hover:text-vs-fg"}`}>
            {item.label}
            {item.count !== null && (
              <span className={`rounded-full px-1.5 font-mono text-[10.5px] leading-[18px] ${item.count > 0 && item.id !== "all" ? "bg-vs-accent text-vs-accent-fg" : "bg-vs-panel text-vs-muted"}`}>{item.count}</span>
            )}
          </button>
        ))}
      </div>
      {/* Most urgent first: handoffs expire within the hour. */}
      <div role="tabpanel" aria-label={tabs.find((item) => item.id === tab)!.label}>
        <div hidden={!all && tab !== "handoffs"}><HandoffInbox inbox={handoffs} label={all ? "Handoffs" : undefined} /></div>
        <div hidden={!all && tab !== "tasks"}><TaskPanel userId={userId} queue={{ label: all ? "My tasks" : undefined }} hideWhenEmpty={all} onCount={setTasks} /></div>
        <div hidden={!all && tab !== "collaboration"}><CollaborationInbox label={all ? "Collaboration" : undefined} onCount={setCollaboration} /></div>
        {all && (!loaded
          ? <p role="status" className="px-4 py-4 text-[13px] text-vs-muted">Checking what needs you…</p>
          : total === 0 && sent === 0 && <p className="px-4 py-4 text-[13px] text-vs-muted">You’re all caught up. Handoffs, tasks assigned to you, and review requests appear here.</p>)}
      </div>
    </section>
  );
}
