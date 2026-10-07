"use client";

import type { ModelInventory } from "../../lib/ai/catalog";
import { SparkleIcon, SpinnerIcon } from "../icons";
import { ComposerPicker } from "./ComposerPicker";

export function ModelPicker({ inventory, value, onChange, onRefresh, refreshing, provider }: {
  inventory: ModelInventory;
  value: string;
  onChange: (value: string) => void;
  onRefresh: () => void;
  refreshing: boolean;
  provider: string;
}) {
  return <ComposerPicker
    label="Choose model"
    value={value}
    onChange={onChange}
    searchable
    searchLabel="Search models"
    icon={<SparkleIcon className="h-4 w-4 shrink-0 text-vs-accent" />}
    options={inventory.choices.map(choice => ({ ...choice, description: choice.id && choice.id !== choice.label ? choice.id : undefined, group: choice.id.includes("/") ? choice.id.split("/")[0] : provider }))}
    header={<button type="button" onClick={onRefresh} disabled={refreshing} className="rounded-lg px-2 py-1 text-sm text-vs-muted hover:bg-vs-hover disabled:opacity-50">{refreshing ? <SpinnerIcon className="h-4 w-4" /> : "Refresh"}</button>}
    footer={<>
      <p>{inventory.source} · {inventory.choices.length} models</p>
      {inventory.stale && <p role="status" className="mt-1 text-vs-warn">{inventory.error ?? "Using fallback choices. Refresh your runner for live model discovery."}</p>}
    </>}
    emptyLabel="No models discovered yet. Connect a provider or start a local model on your runner."
  />;
}
