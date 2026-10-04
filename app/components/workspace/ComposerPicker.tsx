"use client";

import { useEffect, useId, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { CheckIcon, SearchIcon } from "../icons";

export type ComposerOption = { id: string; label: string; description?: string; group?: string };

/** Shared, keyboard-accessible picker anchored above its composer button. */
export function ComposerPicker({ label, value, options, onChange, icon, searchable = false, header, footer, emptyLabel = "No options available." }: {
  label: string;
  value: string;
  options: ComposerOption[];
  onChange: (value: string) => void;
  icon?: ReactNode;
  searchable?: boolean;
  header?: ReactNode;
  footer?: ReactNode;
  emptyLabel?: string;
}) {
  const id = useId();
  const trigger = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [position, setPosition] = useState<CSSProperties>({ visibility: "hidden" });
  const selected = options.find(option => option.id === value);
  const matches = options.filter(option => `${option.label} ${option.id} ${option.group ?? ""}`.toLowerCase().includes(query.trim().toLowerCase()));

  function close(restoreFocus = true) {
    setOpen(false);
    if (restoreFocus) trigger.current?.focus();
  }

  useLayoutEffect(() => {
    if (!open) return;
    function place() {
      const anchor = trigger.current?.getBoundingClientRect();
      if (!anchor) return;
      const width = Math.min(searchable ? 380 : 300, window.innerWidth - 24);
      setPosition({
        width,
        left: Math.max(12, Math.min(anchor.left, window.innerWidth - width - 12)),
        bottom: window.innerHeight - anchor.top + 10,
        maxHeight: Math.max(0, Math.min(480, anchor.top - 22)),
      });
    }
    place();
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    return () => {
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", place, true);
    };
  }, [open, searchable]);

  useEffect(() => {
    if (!open) return;
    const first = panel.current?.querySelector<HTMLElement>('input, [role="option"][aria-selected="true"], [role="option"]');
    // Prefer the selected option for a non-searchable menu.
    (searchable ? first : panel.current?.querySelector<HTMLElement>('[aria-selected="true"]') ?? first)?.focus();
    function outside(event: PointerEvent) {
      if (!panel.current?.contains(event.target as Node) && !trigger.current?.contains(event.target as Node)) setOpen(false);
    }
    function focusOutside(event: FocusEvent) {
      if (!panel.current?.contains(event.target as Node) && !trigger.current?.contains(event.target as Node)) setOpen(false);
    }
    document.addEventListener("pointerdown", outside);
    document.addEventListener("focusin", focusOutside);
    return () => {
      document.removeEventListener("pointerdown", outside);
      document.removeEventListener("focusin", focusOutside);
    };
  }, [open, searchable]);

  return <>
    <button ref={trigger} type="button" aria-label={label} aria-haspopup="dialog" aria-expanded={open} aria-controls={open ? id : undefined} title={`${label}: ${selected?.label ?? (value || "Choose an option")}`} className="composer-control" onClick={() => { setQuery(""); setOpen(!open); }} onKeyDown={event => {
      if (["ArrowUp", "ArrowDown"].includes(event.key)) { event.preventDefault(); setQuery(""); setOpen(true); }
    }}>
      {icon}<span className="truncate">{selected?.label ?? (value ? `Unavailable: ${value}` : label)}</span>
    </button>
    {open && createPortal(<div ref={panel} id={id} role="dialog" aria-label={`${label} options`} style={position} className="composer-picker" onKeyDown={event => {
      if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); close(); return; }
      if (event.key === "Tab") { close(); return; }
      const inSearch = event.target instanceof HTMLInputElement;
      if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key) || (inSearch && ["Home", "End"].includes(event.key))) return;
      event.preventDefault();
      const buttons = Array.from(panel.current?.querySelectorAll<HTMLButtonElement>('[role="option"]') ?? []);
      const current = buttons.indexOf(document.activeElement as HTMLButtonElement);
      const next = event.key === "Home" ? 0 : event.key === "End" ? buttons.length - 1 : current < 0 ? (event.key === "ArrowUp" ? buttons.length - 1 : 0) : (current + (event.key === "ArrowDown" ? 1 : -1) + buttons.length) % buttons.length;
      buttons[next]?.focus();
    }}>
      <div className="composer-picker-heading"><span>{label}</span>{header}</div>
      {searchable && <label className="composer-picker-search"><SearchIcon className="h-4 w-4 shrink-0" /><input aria-label="Search models" placeholder="Search models…" value={query} onChange={event => setQuery(event.target.value)} /></label>}
      <div role="listbox" aria-label={label} className="composer-picker-options vs-scroll">
        {matches.map((option, index) => <div key={option.id}>
          {option.group && option.group !== matches[index - 1]?.group && <div className="composer-picker-group">{option.group}</div>}
          <button type="button" role="option" value={option.id} aria-selected={option.id === value} tabIndex={-1} onClick={() => { onChange(option.id); close(); }} className="composer-picker-option">
            <span className="min-w-0 flex-1"><span className="block break-words">{option.label}</span>{option.description && <span className="composer-picker-description">{option.description}</span>}</span>
            {option.id === value && <CheckIcon className="h-4 w-4 shrink-0 text-vs-accent" />}
          </button>
        </div>)}
        {!matches.length && <p className="p-4 text-sm leading-6 text-vs-muted">{query ? "No matching models." : emptyLabel}</p>}
      </div>
      {footer && <div className="composer-picker-footer vs-scroll">{footer}</div>}
    </div>, document.body)}
  </>;
}
