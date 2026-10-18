"use client";

import { useEffect, useId, useMemo, useRef, useState } from "react";
import type { Org, OrgRole } from "../../lib/org/types";
import { CheckIcon, PlusIcon, SearchIcon, ShieldIcon, UserPlusIcon, UsersIcon } from "../icons";
import { initials } from "./parts";

/*
 * The organisation switcher at the top of the sidebar, in the style of team
 * switchers in Linear, Vercel and shadcn's sidebar: the current organisation
 * with its role, opening a searchable list (⌘/Ctrl+1…9 jump straight to one),
 * the current organisation's own actions, and creating or joining another.
 */

const ROLE: Record<OrgRole, string> = { owner: "Owner", admin: "Admin", member: "Member" };

export function OrgAvatar({ org, size = "md" }: { org: Pick<Org, "name" | "image">; size?: "sm" | "md" }) {
  const box = size === "sm" ? "h-6 w-6 rounded-md text-[10px]" : "h-8 w-8 rounded-lg text-[11px]";
  return (
    <span aria-hidden className={`grid ${box} shrink-0 place-items-center overflow-hidden bg-vs-accent font-semibold text-vs-accent-fg`}>
      {org.image ? <img src={org.image} alt="" className="h-full w-full object-cover" /> : initials(org.name)}
    </span>
  );
}

function ChevronsIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 16 16" fill="none" aria-hidden className={className}>
      <path d="M5 6.25 8 3.5l3 2.75M5 9.75 8 12.5l3-2.75" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
function GearIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 16 16" fill="none" aria-hidden className={className}>
      <path d="M8 10a2 2 0 1 0 0-4 2 2 0 0 0 0 4Z" stroke="currentColor" strokeWidth="1.4" />
      <path d="M13 8c0-.4 0-.7-.1-1l1.3-1-1.3-2.2-1.5.6a5 5 0 0 0-1.7-1L9.5 2h-3l-.3 1.4a5 5 0 0 0-1.7 1l-1.5-.6L1.8 6l1.3 1a5 5 0 0 0 0 2l-1.3 1 1.2 2.2 1.5-.6a5 5 0 0 0 1.7 1l.3 1.4h3l.3-1.4a5 5 0 0 0 1.7-1l1.5.6 1.3-2.2-1.3-1c.1-.3.1-.6.1-1Z" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round" />
    </svg>
  );
}

/**
 * The organisation's view (and this switcher with it) is rebuilt after a
 * switch, so the new switcher takes focus back when the old one had it.
 */
let refocusAfterSwitch = false;

const isMac = () => typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform);

export function OrgSwitcher({ orgs, activeSlug, onSelect, onCreate, onJoin, onSettings, onAdmin, onInvite }: {
  orgs: Org[] | null;
  activeSlug: string | null;
  onSelect: (slug: string) => void;
  onCreate: () => void;
  onJoin: () => void;
  /** The current organisation's own actions; omitted for members who cannot manage it. */
  onSettings?: () => void;
  onAdmin?: () => void;
  onInvite?: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [cursor, setCursor] = useState(0);
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const search = useRef<HTMLInputElement>(null);
  const menuId = useId();
  const active = orgs?.find((org) => org.slug === activeSlug) ?? null;
  const shortcut = isMac() ? "⌘" : "Ctrl+";

  const matches = useMemo(() => {
    const q = query.trim().toLowerCase();
    return (orgs ?? []).filter((org) => !q || org.name.toLowerCase().includes(q) || org.slug.includes(q));
  }, [orgs, query]);
  // Everything the arrow keys move through: organisations, then actions.
  const actions = [
    ...(onSettings ? [{ id: "settings", label: "Organization settings", icon: <GearIcon className="h-4 w-4" />, run: onSettings }] : []),
    ...(onAdmin ? [{ id: "admin", label: "Members & admin", icon: <ShieldIcon className="h-4 w-4" />, run: onAdmin }] : []),
    ...(onInvite ? [{ id: "invite", label: "Invite people", icon: <UserPlusIcon className="h-4 w-4" />, run: onInvite }] : []),
    { id: "create", label: "Create organization", icon: <PlusIcon className="h-4 w-4" />, run: onCreate },
    { id: "join", label: "Join organization", icon: <UsersIcon className="h-4 w-4" />, run: onJoin },
  ];
  const ownActions = actions.filter((item) => ["settings", "admin", "invite"].includes(item.id));
  const otherActions = actions.filter((item) => !["settings", "admin", "invite"].includes(item.id));
  const total = matches.length + ownActions.length + otherActions.length;

  function close(refocus = true) {
    setOpen(false);
    setQuery("");
    if (refocus) trigger.current?.focus();
  }
  function choose(index: number) {
    if (index < matches.length) { close(); refocusAfterSwitch = matches[index].slug !== activeSlug; onSelect(matches[index].slug); return; }
    const action = [...ownActions, ...otherActions][index - matches.length];
    // Focus returns to the switcher first, so a dialog the action opens hands it back there.
    if (action) { close(); action.run(); }
  }

  useEffect(() => {
    if (!refocusAfterSwitch) return;
    refocusAfterSwitch = false;
    trigger.current?.focus();
  }, []);

  useEffect(() => {
    if (!open) return;
    search.current?.focus();
    const away = (event: PointerEvent) => { if (!root.current?.contains(event.target as Node)) { setOpen(false); setQuery(""); } };
    document.addEventListener("pointerdown", away);
    return () => document.removeEventListener("pointerdown", away);
  }, [open]);

  // ⌘/Ctrl+1…9 switch organisations from anywhere except while typing.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey) || event.altKey || event.shiftKey || !/^[1-9]$/.test(event.key)) return;
      const target = event.target as HTMLElement | null;
      if (target && (target.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName))) return;
      const org = orgs?.[Number(event.key) - 1];
      if (!org) return;
      event.preventDefault();
      onSelect(org.slug);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [orgs, onSelect]);

  function onMenuKey(event: React.KeyboardEvent) {
    // Closes this menu only, not the phone drawer around it.
    if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); close(); return; }
    if (!total) return;
    if (event.key === "ArrowDown") { event.preventDefault(); setCursor((value) => (value + 1) % total); }
    else if (event.key === "ArrowUp") { event.preventDefault(); setCursor((value) => (value - 1 + total) % total); }
    else if (event.key === "Home") { event.preventDefault(); setCursor(0); }
    else if (event.key === "End") { event.preventDefault(); setCursor(total - 1); }
    else if (event.key === "Enter") { event.preventDefault(); choose(Math.min(cursor, total - 1)); }
  }

  const row = (index: number) => `flex w-full items-center gap-2.5 rounded-lg px-2 py-1.5 text-left text-[13px] transition ${index === cursor ? "bg-vs-hover text-vs-fg" : "text-vs-fg/90"}`;

  return (
    <div ref={root} className="relative">
      <button
        ref={trigger}
        type="button"
        aria-label="Switch organization"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        disabled={orgs === null}
        onClick={() => { if (open) close(); else { setCursor(Math.max(0, orgs?.findIndex((org) => org.slug === activeSlug) ?? 0)); setOpen(true); } }}
        className="group flex w-full items-center gap-2.5 rounded-xl p-1.5 text-left transition hover:bg-vs-hover aria-expanded:bg-vs-hover disabled:opacity-60"
      >
        {active ? <OrgAvatar org={active} /> : <span aria-hidden className="grid h-8 w-8 shrink-0 place-items-center rounded-lg border border-dashed border-vs-border text-vs-muted"><PlusIcon className="h-4 w-4" /></span>}
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[13px] font-semibold leading-5 text-vs-fg">{active?.name ?? (orgs === null ? "Loading…" : "Choose an organization")}</span>
          <span className="block truncate text-[11px] leading-4 text-vs-muted">{active ? `${ROLE[active.myRole]} · ${orgs!.length} organization${orgs!.length === 1 ? "" : "s"}` : "Create or join one"}</span>
        </span>
        <ChevronsIcon className="h-4 w-4 shrink-0 text-vs-muted group-hover:text-vs-fg" />
      </button>

      {open && (
        <div id={menuId} role="menu" aria-label="Organizations" onKeyDown={onMenuKey}
          className="absolute left-0 top-full z-50 mt-1.5 w-[max(100%,272px)] max-w-[calc(100vw-1rem)] overflow-hidden rounded-xl border border-vs-border bg-vs-panel p-1.5 shadow-[0_18px_48px_rgb(0_0_0_/_0.45)]">
          <label className="mb-1 flex items-center gap-2 rounded-lg border border-vs-border bg-vs-editor px-2.5 focus-within:border-vs-accent">
            <SearchIcon className="h-3.5 w-3.5 shrink-0 text-vs-muted" />
            <input ref={search} aria-label="Search organizations" placeholder="Find an organization…" value={query}
              onChange={(event) => { setQuery(event.target.value); setCursor(0); }}
              className="min-w-0 flex-1 bg-transparent py-1.5 text-[13px] text-vs-fg outline-none placeholder:text-vs-muted" />
          </label>
          <p className="px-2 pb-1 pt-1.5 text-[11px] font-medium uppercase tracking-wider text-vs-muted">Organizations</p>
          <div className="vs-scroll max-h-64 overflow-y-auto">
            {matches.length === 0 && <p role="status" className="px-2 py-2 text-[13px] text-vs-muted">{orgs?.length ? "No organizations found. Try another name." : "You haven’t joined any organizations yet."}</p>}
            {matches.map((org, index) => {
              const current = org.slug === activeSlug;
              const position = (orgs ?? []).indexOf(org);
              return (
                <button key={org.slug} type="button" role="menuitemradio" aria-checked={current} title={org.name}
                  onMouseEnter={() => setCursor(index)} onClick={() => choose(index)} className={row(index)}>
                  <OrgAvatar org={org} size="sm" />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate font-medium">{org.name}</span>
                    <span className="block truncate text-[11px] text-vs-muted">{ROLE[org.myRole]}</span>
                  </span>
                  {current ? <CheckIcon className="h-4 w-4 shrink-0 text-vs-accent" /> : position < 9 && <kbd className="shrink-0 font-sans text-[11px] text-vs-muted">{shortcut}{position + 1}</kbd>}
                </button>
              );
            })}
          </div>
          {ownActions.length > 0 && <div className="my-1.5 border-t border-vs-border" />}
          {ownActions.map((item, offset) => {
            const index = matches.length + offset;
            return (
              <button key={item.id} type="button" role="menuitem" onMouseEnter={() => setCursor(index)} onClick={() => choose(index)} className={row(index)}>
                <span className="grid h-6 w-6 place-items-center text-vs-muted">{item.icon}</span>{item.label}
              </button>
            );
          })}
          <div className="my-1.5 border-t border-vs-border" />
          {otherActions.map((item, offset) => {
            const index = matches.length + ownActions.length + offset;
            return (
              <button key={item.id} type="button" role="menuitem" onMouseEnter={() => setCursor(index)} onClick={() => choose(index)} className={row(index)}>
                <span className="grid h-6 w-6 place-items-center rounded-md border border-dashed border-vs-border text-vs-muted">{item.icon}</span>{item.label}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
