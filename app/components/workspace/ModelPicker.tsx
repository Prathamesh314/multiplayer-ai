"use client";

import { useState } from "react";
import type { AgentChoice, ModelInventory } from "../../lib/ai/catalog";
import { Modal } from "../ui/Modal";
import { ChevronIcon, SearchIcon, SpinnerIcon } from "../icons";

export function ModelPicker({ inventory, value, onChange, onRefresh, refreshing, provider }: {
  inventory: ModelInventory;
  value: string;
  onChange: (value: string) => void;
  onRefresh: () => void;
  refreshing: boolean;
  provider: string;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const selected = inventory.choices.find(choice => choice.id === value);
  const matches = inventory.choices.filter(choice => `${choice.id} ${choice.label}`.toLowerCase().includes(query.trim().toLowerCase()));
  const groups = new Map<string, AgentChoice[]>();
  for (const choice of matches) {
    const group = choice.id.includes("/") ? choice.id.split("/")[0] : provider;
    groups.set(group, [...(groups.get(group) ?? []), choice]);
  }
  return <>
    <button type="button" aria-label="Choose model" onClick={() => setOpen(true)} className="flex min-w-0 max-w-52 items-center gap-1 rounded-full px-2 py-1 text-xs hover:bg-vs-hover" title={selected?.label ?? value}>
      <span className="truncate">{selected?.label ?? (value ? `Unavailable: ${value}` : "Choose model")}</span>
      <ChevronIcon className="h-3 w-3 shrink-0 rotate-90 text-vs-muted" />
    </button>
    {open && <Modal title={`Models · ${provider}`} description="Model inventories refresh automatically. Selecting a model does not start a run or download model weights." onClose={() => setOpen(false)} width="max-w-xl">
      <div className="space-y-3 p-4">
        <div className="flex items-center gap-2">
          <label className="flex min-w-0 flex-1 items-center gap-2 rounded-lg border border-vs-border px-3 py-2 focus-within:border-vs-accent">
            <SearchIcon className="h-4 w-4 shrink-0 text-vs-muted" />
            <input autoFocus aria-label="Search models" placeholder="Search models or providers…" value={query} onChange={event => setQuery(event.target.value)} className="min-w-0 flex-1 bg-transparent text-sm outline-none" />
          </label>
          <button type="button" onClick={onRefresh} disabled={refreshing} className="rounded-lg border border-vs-border px-3 py-2 text-xs hover:bg-vs-hover disabled:opacity-50">{refreshing ? <SpinnerIcon className="h-4 w-4" /> : "Refresh"}</button>
        </div>
        <p className="text-xs text-vs-muted">{inventory.source} · {inventory.choices.length} models{inventory.refreshedAt ? ` · updated ${new Date(inventory.refreshedAt).toLocaleTimeString()}` : ""}</p>
        {inventory.stale && <p role="status" className="rounded-lg bg-vs-warn/10 p-3 text-xs text-vs-warn">{inventory.error ?? "Using fallback choices. Update and restart your runner for live model discovery."}</p>}
        <div className="vs-scroll max-h-80 space-y-3 overflow-y-auto">
          {[...groups].map(([name, choices]) => <section key={name} aria-label={name}>
            <h3 className="mb-1 px-2 text-xs font-semibold uppercase tracking-wide text-vs-muted">{name}</h3>
            {choices.map(choice => <button type="button" key={choice.id} aria-pressed={choice.id === value} onClick={() => { onChange(choice.id); setOpen(false); }} className={`block w-full rounded-lg px-3 py-2 text-left text-sm hover:bg-vs-hover ${choice.id === value ? "bg-vs-active" : ""}`}>
              <span className="block break-words font-medium">{choice.label}</span>
              {choice.id && <span className="block break-all font-mono text-xs text-vs-muted">{choice.id}</span>}
            </button>)}
          </section>)}
          {matches.length === 0 && <p className="p-4 text-center text-sm text-vs-muted">{query ? "No matching models." : "No models discovered yet. Connect a provider in its CLI, or start Ollama/LM Studio and install a compatible model on your runner."}</p>}
        </div>
        <p className="text-xs leading-5 text-vs-muted">Runner inventories sync in the background. A listed model still requires account access, compatible tool support, and sufficient local memory. Pinned selections are never silently replaced.</p>
      </div>
    </Modal>}
  </>;
}
