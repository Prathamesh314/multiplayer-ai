"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import type { AgentTool } from "../../lib/ai/agent-tools";
import {
  describeSpec, formatVars, joinCommand, parseVars, splitCommand, TOOL_PRESETS, ToolSpecError,
  type ToolKind, type ToolSpec,
} from "../../lib/ai/agent-tools-spec";
import { desktopBridge } from "../../lib/desktop";
import { openUserStream } from "../../lib/events/shared-client";
import { CheckIcon, PlusIcon, SpinnerIcon } from "../icons";
import { ErrorNote, Field, GhostButton, Modal, PrimaryButton, inputClass } from "../ui/Modal";

/*
 * MCP servers and plugins for the agents, configured here instead of in each
 * member's terminal. Used for a project's tools (managers add them, every
 * member allows them for their own computer) and for a member's own tools.
 * Keys are typed into the desktop app and stay on that computer.
 */

type ToolsData = { tools: AgentTool[]; canManage?: boolean; secretNames: string[]; computersReady: boolean };
type Props = { base: string; scope: "project" | "personal"; projectName?: string };

type Draft = {
  name: string; kind: ToolKind; transport: "stdio" | "http"; source: "git" | "zip";
  command: string; url: string; env: string; headers: string; ref: string; path: string;
};
const emptyDraft: Draft = { name: "", kind: "mcp", transport: "stdio", source: "git", command: "", url: "", env: "", headers: "", ref: "", path: "" };

function toDraft(name: string, kind: ToolKind, spec: ToolSpec): Draft {
  const draft = { ...emptyDraft, name, kind };
  if ("transport" in spec) {
    if (spec.transport === "stdio") return { ...draft, transport: "stdio", command: joinCommand([spec.command, ...spec.args]), env: formatVars(spec.env, "=") };
    return { ...draft, transport: "http", url: spec.url, headers: formatVars(spec.headers, ":") };
  }
  return spec.source === "git" ? { ...draft, source: "git", url: spec.url, ref: spec.ref ?? "", path: spec.path ?? "" } : { ...draft, source: "zip", url: spec.url };
}

function fromDraft(draft: Draft) {
  if (draft.kind === "mcp") {
    if (draft.transport === "stdio") {
      const [command, ...args] = splitCommand(draft.command);
      if (!command) throw new ToolSpecError("Enter the command that starts the server.");
      return { name: draft.name, kind: "mcp", spec: { transport: "stdio", command, args, env: parseVars(draft.env, "=") } };
    }
    return { name: draft.name, kind: "mcp", spec: { transport: "http", url: draft.url, headers: parseVars(draft.headers, ":") } };
  }
  return { name: draft.name, kind: "plugin", spec: draft.source === "git" ? { source: "git", url: draft.url, ref: draft.ref, path: draft.path } : { source: "zip", url: draft.url } };
}

async function send(url: string, method: string, body?: unknown) {
  const response = await fetch(url, { method, headers: body ? { "content-type": "application/json" } : undefined, body: body ? JSON.stringify(body) : undefined });
  const data = await response.json().catch(() => null) as { error?: string } | null;
  if (!response.ok) throw new Error(data?.error ?? "Something went wrong. Please try again.");
  return data;
}

export function AgentToolsPanel({ base, scope, projectName }: Props) {
  const [data, setData] = useState<ToolsData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [editing, setEditing] = useState<{ id?: string; draft: Draft } | null>(null);
  const [keys, setKeys] = useState<{ name: string } | null>(null);
  const [localNames, setLocalNames] = useState<string[]>([]);
  const desktop = typeof window === "undefined" ? undefined : desktopBridge();
  const canKeys = !!desktop?.setSecret;

  const reload = useCallback(async () => {
    try {
      const response = await fetch(base, { cache: "no-store" });
      const next = await response.json().catch(() => null) as ToolsData & { error?: string } | null;
      if (!response.ok || !next) throw new Error(next?.error ?? "Could not load AI tools.");
      setData(next); setError(null);
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    if (desktop?.secretNames) void desktop.secretNames().then((result) => setLocalNames(result.names ?? [])).catch(() => {});
  }, [base, desktop]);

  useEffect(() => {
    const load = () => { if (!document.hidden) void reload(); };
    load();
    // A computer reports new keys with its next heartbeat.
    const stream = openUserStream((type) => { if (type === "devices.changed") load(); }, load);
    return () => stream.close();
  }, [reload]);

  const held = useMemo(() => new Set([...(data?.secretNames ?? []), ...localNames]), [data, localNames]);
  const manage = scope === "personal" || !!data?.canManage;

  const act = async (key: string, work: () => Promise<unknown>) => {
    setBusy(key); setError(null);
    try { await work(); await reload(); } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); } finally { setBusy(null); }
  };

  return (
    <section aria-label={scope === "project" ? "AI tools for this project" : "Your AI tools"} className="min-w-0">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 className="text-sm font-semibold">{scope === "project" ? "AI tools" : "Your AI tools"}</h2>
          <p className="mt-1 max-w-2xl text-xs leading-5 text-vs-muted">
            {scope === "project"
              ? <>MCP servers and plugins for Claude Code and Codex in {projectName ? <span className="text-vs-fg">{projectName}</span> : "this project"}’s chats. They run on each member’s own computer, only after that member allows them.</>
              : <>MCP servers and plugins for every chat you drive, in any project. Only you use them, on your own computer.</>}
            {" "}Your own CLI settings are left as they are.
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <GhostButton className="whitespace-nowrap" onClick={() => setKeys({ name: "" })}>Keys on this computer</GhostButton>
          {manage && (
            <PrimaryButton className="whitespace-nowrap" onClick={() => setEditing({ draft: emptyDraft })}><PlusIcon className="h-3.5 w-3.5" />Add tool</PrimaryButton>
          )}
        </div>
      </div>
      {error && <div className="mt-3"><ErrorNote>{error}</ErrorNote></div>}
      {data && !data.computersReady && data.tools.length > 0 && (
        <p role="status" className="mt-3 rounded-lg border border-vs-border bg-vs-editor/50 p-2.5 text-xs leading-5 text-vs-muted">
          Update the desktop app (or the runner) on your computer to use these tools. Older versions run chats without them.
        </p>
      )}
      {!data ? (
        <p role="status" className="mt-4 flex items-center gap-2 text-xs text-vs-muted"><SpinnerIcon className="h-3.5 w-3.5" />Loading AI tools…</p>
      ) : data.tools.length === 0 ? (
        <p className="mt-3 rounded-xl border border-dashed border-vs-border p-4 text-xs leading-5 text-vs-muted">
          No tools yet.{manage ? " Add one, for example Playwright to let agents test pages in a real browser." : " A project manager can add them."}
        </p>
      ) : (
        <ul className="mt-3 grid gap-3 md:grid-cols-2">
          {data.tools.map((tool) => {
            const missing = tool.secrets.filter((name) => !held.has(name));
            return (
              <li key={tool.id} className="flex min-w-0 flex-col rounded-2xl border border-vs-border bg-vs-panel p-4" aria-label={`${tool.name} tool`}>
                <div className="flex items-start gap-2.5">
                  <span aria-hidden className={`grid h-8 w-8 shrink-0 place-items-center rounded-lg text-[11px] font-semibold ${tool.kind === "mcp" ? "bg-sky-500/15 text-sky-300" : "bg-amber-500/15 text-amber-300"}`}>
                    {tool.kind === "mcp" ? "MCP" : "PL"}
                  </span>
                  <div className="min-w-0 flex-1">
                    <h3 className="flex flex-wrap items-center gap-2 text-sm font-semibold">
                      {tool.name}
                      {!tool.enabled && <span className="rounded-full border border-vs-border px-1.5 text-[10px] font-medium text-vs-muted">Off</span>}
                      {tool.kind === "plugin" && <span className="text-[10px] font-normal text-vs-muted">Claude Code</span>}
                    </h3>
                    <code className="mt-1 block break-all font-mono text-[11px] leading-4 text-vs-muted">{describeSpec(tool.spec)}</code>
                  </div>
                </div>
                {tool.secrets.length > 0 && (
                  <div className="mt-3 flex flex-wrap gap-1.5" aria-label="Keys this tool needs">
                    {tool.secrets.map((name) => held.has(name) ? (
                      <span key={name} className="inline-flex items-center gap-1 rounded-full bg-emerald-500/10 px-2 py-0.5 font-mono text-[10px] text-emerald-300"><CheckIcon className="h-3 w-3" />{name}</span>
                    ) : (
                      <button key={name} type="button" onClick={() => setKeys({ name })} className="rounded-full border border-amber-500/40 px-2 py-0.5 font-mono text-[10px] text-amber-300 hover:bg-amber-500/10">
                        Add {name}
                      </button>
                    ))}
                  </div>
                )}
                {scope === "project" && !tool.approved && (
                  <div className="mt-3 rounded-xl border border-amber-500/30 bg-amber-500/5 p-3 text-xs leading-5">
                    <p className="text-vs-fg">Not allowed on your computer yet.</p>
                    <p className="mt-0.5 text-vs-muted">
                      {tool.kind === "mcp" && "transport" in tool.spec && tool.spec.transport === "stdio"
                        ? "Allowing it lets your agents start this command on your computer."
                        : tool.kind === "plugin" ? "A plugin can add commands, agents and hooks that run on your computer." : "Allowing it lets your agents call this server."}
                      {" "}If it changes, you’ll be asked again.
                    </p>
                    <PrimaryButton className="mt-2" disabled={!!busy} onClick={() => void act(`allow:${tool.id}`, () => send(`${base}/${tool.id}/approval`, "POST"))}>
                      {busy === `allow:${tool.id}` ? "Allowing…" : "Allow on my computer"}
                    </PrimaryButton>
                  </div>
                )}
                <div className="mt-auto flex flex-wrap items-center gap-2 pt-3 text-xs text-vs-muted">
                  {scope === "project" && tool.approved && <span className="mr-auto inline-flex items-center gap-1 text-emerald-300"><CheckIcon className="h-3.5 w-3.5" />Allowed{missing.length ? ", needs keys" : ""}</span>}
                  {scope === "personal" && <span className="mr-auto">{missing.length ? "Needs keys" : tool.enabled ? "In your chats" : "Turned off"}</span>}
                  {scope === "project" && tool.approved && (
                    <GhostButton disabled={!!busy} onClick={() => void act(`revoke:${tool.id}`, () => send(`${base}/${tool.id}/approval`, "DELETE"))}>Stop allowing</GhostButton>
                  )}
                  {manage && (
                    <>
                      <GhostButton disabled={!!busy} onClick={() => void act(`toggle:${tool.id}`, () => send(`${base}/${tool.id}`, "PATCH", { enabled: !tool.enabled }))}>
                        {tool.enabled ? "Turn off" : "Turn on"}
                      </GhostButton>
                      <GhostButton disabled={!!busy} onClick={() => setEditing({ id: tool.id, draft: toDraft(tool.name, tool.kind, tool.spec) })}>Edit</GhostButton>
                      <GhostButton disabled={!!busy} onClick={() => { if (confirm(`Remove ${tool.name}?`)) void act(`delete:${tool.id}`, () => send(`${base}/${tool.id}`, "DELETE")); }}>Remove</GhostButton>
                    </>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      )}
      {editing && (
        <ToolEditor
          initial={editing.draft}
          editing={!!editing.id}
          scope={scope}
          onClose={() => setEditing(null)}
          onSave={async (body) => {
            await send(editing.id ? `${base}/${editing.id}` : base, editing.id ? "PATCH" : "POST", body);
            setEditing(null);
            await reload();
          }}
        />
      )}
      {keys && (
        <KeysDialog
          initialName={keys.name}
          canKeys={canKeys}
          names={localNames}
          wanted={[...new Set((data?.tools ?? []).flatMap((tool) => tool.secrets))].sort()}
          held={held}
          onClose={() => setKeys(null)}
          onChanged={(names) => { setLocalNames(names); void reload(); }}
        />
      )}
    </section>
  );
}

function ToolEditor({ initial, editing, scope, onClose, onSave }: {
  initial: Draft; editing: boolean; scope: Props["scope"]; onClose: () => void; onSave: (body: unknown) => Promise<void>;
}) {
  const [draft, setDraft] = useState(initial);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const set = (patch: Partial<Draft>) => setDraft((current) => ({ ...current, ...patch }));
  const save = async () => {
    setSaving(true); setError(null);
    try { await onSave(fromDraft(draft)); } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); } finally { setSaving(false); }
  };
  const tab = (active: boolean) => `rounded-lg px-3 py-1.5 text-xs font-medium transition ${active ? "bg-vs-accent text-vs-accent-fg" : "text-vs-muted hover:bg-vs-hover hover:text-vs-fg"}`;
  return (
    <Modal
      title={editing ? `Edit ${initial.name}` : "Add an AI tool"}
      description={scope === "project" ? "Members allow it before it runs on their computers. Changing a tool asks them again." : "Used in every chat you drive."}
      width="max-w-xl"
      onClose={onClose}
      footer={<><GhostButton onClick={onClose}>Cancel</GhostButton><PrimaryButton disabled={saving} onClick={() => void save()}>{saving ? "Saving…" : editing ? "Save" : "Add tool"}</PrimaryButton></>}
    >
      {!editing && (
        <div>
          <p className="text-xs font-medium">Start from</p>
          <div className="mt-1.5 flex flex-wrap gap-1.5">
            {TOOL_PRESETS.map((preset) => (
              <button key={preset.id} type="button" title={preset.description}
                onClick={() => setDraft(toDraft(preset.name, preset.kind, preset.spec))}
                className="rounded-full border border-vs-border px-2.5 py-1 text-xs hover:border-vs-accent hover:bg-vs-hover">
                {preset.label}
              </button>
            ))}
          </div>
        </div>
      )}
      <div role="tablist" aria-label="Kind of tool" className="flex gap-1 rounded-xl border border-vs-border p-1">
        <button type="button" role="tab" aria-selected={draft.kind === "mcp"} className={tab(draft.kind === "mcp")} onClick={() => set({ kind: "mcp" })}>MCP server</button>
        <button type="button" role="tab" aria-selected={draft.kind === "plugin"} className={tab(draft.kind === "plugin")} onClick={() => set({ kind: "plugin" })}>Claude Code plugin</button>
      </div>
      <Field label="Name" hint="Lowercase letters, numbers, - and _. Agents see the tools under this name.">
        <input className={inputClass} value={draft.name} onChange={(event) => set({ name: event.target.value })} placeholder="playwright" autoComplete="off" spellCheck={false} />
      </Field>
      {draft.kind === "mcp" ? (
        <>
          <div role="radiogroup" aria-label="How it runs" className="flex flex-wrap gap-3 text-xs">
            <label className="flex items-center gap-1.5"><input type="radio" checked={draft.transport === "stdio"} onChange={() => set({ transport: "stdio" })} />A command on the computer</label>
            <label className="flex items-center gap-1.5"><input type="radio" checked={draft.transport === "http"} onChange={() => set({ transport: "http" })} />A remote URL (HTTP)</label>
          </div>
          {draft.transport === "stdio" ? (
            <>
              <Field label="Command" hint="Runs on each computer without a shell. Use ${NAME} for a key, e.g. ${DATABASE_URL}.">
                <input className={`${inputClass} font-mono`} value={draft.command} onChange={(event) => set({ command: event.target.value })} placeholder="npx -y @playwright/mcp@latest" spellCheck={false} />
              </Field>
              <Field label="Environment (optional)" hint="One NAME=value per line. Put keys as ${NAME}, never the key itself.">
                <textarea className={`${inputClass} min-h-16 font-mono`} value={draft.env} onChange={(event) => set({ env: event.target.value })} placeholder={"API_KEY=${MY_SERVICE_KEY}"} spellCheck={false} />
              </Field>
            </>
          ) : (
            <>
              <Field label="URL">
                <input className={`${inputClass} font-mono`} value={draft.url} onChange={(event) => set({ url: event.target.value })} placeholder="https://mcp.example.com/mcp" spellCheck={false} />
              </Field>
              <Field label="Headers (optional)" hint="One Name: value per line. Put keys as ${NAME}, never the key itself.">
                <textarea className={`${inputClass} min-h-16 font-mono`} value={draft.headers} onChange={(event) => set({ headers: event.target.value })} placeholder={"Authorization: Bearer ${GITHUB_TOKEN}"} spellCheck={false} />
              </Field>
            </>
          )}
        </>
      ) : (
        <>
          <div role="radiogroup" aria-label="Where the plugin comes from" className="flex flex-wrap gap-3 text-xs">
            <label className="flex items-center gap-1.5"><input type="radio" checked={draft.source === "git"} onChange={() => set({ source: "git" })} />A Git repository</label>
            <label className="flex items-center gap-1.5"><input type="radio" checked={draft.source === "zip"} onChange={() => set({ source: "zip" })} />A .zip URL</label>
          </div>
          <Field label={draft.source === "git" ? "Repository URL" : "Plugin .zip URL"}>
            <input className={`${inputClass} font-mono`} value={draft.url} onChange={(event) => set({ url: event.target.value })} placeholder={draft.source === "git" ? "https://github.com/org/plugin.git" : "https://example.com/plugin.zip"} spellCheck={false} />
          </Field>
          {draft.source === "git" && (
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="Tag or branch (optional)" hint="A tag keeps what runs from changing under members.">
                <input className={`${inputClass} font-mono`} value={draft.ref} onChange={(event) => set({ ref: event.target.value })} placeholder="v1.2.0" spellCheck={false} />
              </Field>
              <Field label="Folder (optional)" hint="Where the plugin is inside the repository.">
                <input className={`${inputClass} font-mono`} value={draft.path} onChange={(event) => set({ path: event.target.value })} placeholder="plugins/review" spellCheck={false} />
              </Field>
            </div>
          )}
          <p className="text-[11px] leading-4 text-vs-muted">Plugins load in Claude Code chats for that run only. Codex chats use MCP servers.</p>
        </>
      )}
      {error && <ErrorNote>{error}</ErrorNote>}
    </Modal>
  );
}

function KeysDialog({ initialName, canKeys, names, wanted, held, onClose, onChanged }: {
  initialName: string; canKeys: boolean; names: string[]; wanted: string[]; held: Set<string>;
  onClose: () => void; onChanged: (names: string[]) => void;
}) {
  const [name, setName] = useState(initialName);
  const [value, setValue] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState<string | null>(null);
  const desktop = desktopBridge();
  const save = async () => {
    setError(null); setSaved(null);
    const result = await desktop?.setSecret?.(name.trim(), value);
    if (!result?.ok) { setError(result?.error ?? "Could not save the key."); return; }
    setValue(""); setSaved(name.trim()); onChanged(result.names ?? []);
  };
  const remove = async (target: string) => {
    const result = await desktop?.removeSecret?.(target);
    if (!result?.ok) { setError(result?.error ?? "Could not remove the key."); return; }
    onChanged(result.names ?? []);
  };
  return (
    <Modal title="Keys on this computer" description="Tools refer to keys as ${NAME}. Each member adds their own; they stay on that computer and are never sent to the workspace." onClose={onClose}
      footer={<GhostButton onClick={onClose}>Done</GhostButton>}>
      {canKeys ? (
        <>
          <div className="grid gap-3 sm:grid-cols-[1fr_1.4fr]">
            <Field label="Name">
              <input className={`${inputClass} font-mono`} value={name} onChange={(event) => setName(event.target.value.toUpperCase())} placeholder="GITHUB_TOKEN" list="wanted-keys" autoComplete="off" spellCheck={false} />
              <datalist id="wanted-keys">{wanted.map((item) => <option key={item} value={item} />)}</datalist>
            </Field>
            <Field label="Value">
              <input className={`${inputClass} font-mono`} type="password" value={value} onChange={(event) => setValue(event.target.value)} autoComplete="off" spellCheck={false} />
            </Field>
          </div>
          <div className="flex items-center gap-2">
            <PrimaryButton disabled={!name.trim() || !value} onClick={() => void save()}>Save on this computer</PrimaryButton>
            {saved && <span role="status" className="text-xs text-emerald-300">Saved {saved}.</span>}
          </div>
          {names.length > 0 && (
            <ul className="divide-y divide-vs-border rounded-xl border border-vs-border" aria-label="Keys saved on this computer">
              {names.map((item) => (
                <li key={item} className="flex items-center gap-2 px-3 py-2 text-xs">
                  <code className="flex-1 font-mono">{item}</code>
                  <span className="text-vs-muted">••••••</span>
                  <GhostButton onClick={() => void remove(item)}>Remove</GhostButton>
                </li>
              ))}
            </ul>
          )}
        </>
      ) : (
        <div className="space-y-2 text-xs leading-5 text-vs-muted">
          <p>{desktopBridge()?.isDesktop ? "Update the desktop app to add keys here, or use" : "Add keys in the Multicode AI desktop app (open this page there), or with"} the runner on your computer:</p>
          <pre className="overflow-x-auto rounded-lg border border-vs-border bg-vs-editor p-2.5 font-mono text-[11px] text-vs-fg">multicode-ai-runner secret set {name || "GITHUB_TOKEN"}</pre>
          <p>It asks for the value; nothing is sent to the workspace.</p>
        </div>
      )}
      {wanted.length > 0 && (
        <p className="text-[11px] leading-4 text-vs-muted">
          Tools here use: {wanted.map((item, index) => <span key={item}>{index ? ", " : ""}<code className={held.has(item) ? "text-emerald-300" : "text-amber-300"}>{item}</code></span>)}
        </p>
      )}
      {error && <ErrorNote>{error}</ErrorNote>}
    </Modal>
  );
}
