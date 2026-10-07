"use client";

import { useEffect, useId, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { CheckIcon, SearchIcon } from "../icons";

export type ComposerOption = { id: string; label: string; description?: string; group?: string };

/** Shared picker for composer controls and form fields, including modal dialogs. */
export function ComposerPicker({ label, value, options, onChange, icon, searchable = false, searchLabel = "Search options", placeholder, header, footer, emptyLabel = "No options available.", className = "", placement = "top", disabled = false, variant = "compact" }: {
  label: string;
  value: string;
  options: ComposerOption[];
  onChange: (value: string) => void;
  icon?: ReactNode;
  searchable?: boolean;
  searchLabel?: string;
  placeholder?: string;
  header?: ReactNode;
  footer?: ReactNode;
  emptyLabel?: string;
  className?: string;
  placement?: "top" | "auto";
  disabled?: boolean;
  variant?: "compact" | "field";
}) {
  const id = useId();
  const trigger = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [portalRoot, setPortalRoot] = useState<HTMLElement | null>(null);
  const [query, setQuery] = useState("");
  const [position, setPosition] = useState<CSSProperties>({ visibility: "hidden" });
  const selected = options.find(option => option.id === value);
  const matches = options.filter(option => `${option.label} ${option.id} ${option.description ?? ""} ${option.group ?? ""}`.toLowerCase().includes(query.trim().toLowerCase()));
  const expanded = open && !disabled;

  function show() {
    setPortalRoot(trigger.current?.closest("dialog") ?? document.body);
    setQuery("");
    setOpen(true);
  }

  function close(restoreFocus = true) {
    setOpen(false);
    if (restoreFocus) trigger.current?.focus();
  }

  useLayoutEffect(() => {
    if (!expanded) return;
    // The top layer escapes scroll/overflow clipping. Keeping the portal in
    // its owning dialog also keeps it inside that modal's focus boundary.
    const popup = panel.current;
    popup?.showPopover?.();
    function place() {
      const anchor = trigger.current?.getBoundingClientRect();
      if (!anchor) return;
      const width = Math.min(searchable ? 380 : 300, window.innerWidth - 24);
      const above = Math.max(0, anchor.top - 22);
      const below = Math.max(0, window.innerHeight - anchor.bottom - 22);
      const openAbove = (placement === "top" && above >= Math.min(200, below)) || above >= below;
      const left = variant === "field" && portalRoot?.tagName === "DIALOG" ? anchor.right - width : anchor.left;
      setPosition({
        width,
        left: Math.max(12, Math.min(left, window.innerWidth - width - 12)),
        ...(openAbove ? { bottom: window.innerHeight - anchor.top + 10 } : { top: anchor.bottom + 10 }),
        maxHeight: Math.min(480, openAbove ? above : below),
      });
    }
    place();
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    const observer = new ResizeObserver(place);
    if (trigger.current) observer.observe(trigger.current);
    return () => {
      if (popup?.hidePopover && popup.matches(":popover-open")) popup.hidePopover();
      observer.disconnect();
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", place, true);
    };
  }, [expanded, searchable, placement, variant, portalRoot]);

  useEffect(() => {
    if (!expanded || position.visibility === "hidden") return;
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
  }, [expanded, searchable, position.visibility]);

  return <>
    <button ref={trigger} type="button" disabled={disabled} aria-label={label} aria-haspopup="dialog" aria-expanded={expanded} aria-controls={expanded ? id : undefined} title={`${label}: ${selected?.label ?? (value || placeholder || "Choose an option")}`} className={`composer-control ${variant === "field" ? "picker-field" : ""} ${className}`} onClick={() => { if (expanded) close(); else show(); }} onKeyDown={event => {
      if (["ArrowUp", "ArrowDown"].includes(event.key)) { event.preventDefault(); show(); }
    }}>
      {icon}<span className="truncate">{selected?.label ?? (value ? `Unavailable: ${value}` : placeholder ?? label)}</span>
    </button>
    {expanded && portalRoot && createPortal(<div ref={panel} id={id} popover="manual" role="dialog" aria-label={`${label} options`} style={position} className="composer-picker" onKeyDown={event => {
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
      {searchable && <label className="composer-picker-search"><SearchIcon className="h-4 w-4 shrink-0" /><input aria-label={searchLabel} placeholder={`${searchLabel}…`} value={query} onChange={event => setQuery(event.target.value)} /></label>}
      <div role="listbox" aria-label={label} className="composer-picker-options vs-scroll">
        {matches.map((option, index) => <div key={option.id}>
          {option.group && option.group !== matches[index - 1]?.group && <div className="composer-picker-group">{option.group}</div>}
          <button type="button" role="option" value={option.id} aria-selected={option.id === value} tabIndex={-1} onClick={() => { onChange(option.id); close(); }} className="composer-picker-option">
            <span className="min-w-0 flex-1"><span className="block break-words">{option.label}</span>{option.description && <span className="composer-picker-description">{option.description}</span>}</span>
            {option.id === value && <CheckIcon className="h-4 w-4 shrink-0 text-vs-accent" />}
          </button>
        </div>)}
        {!matches.length && <p role="status" className="p-4 text-sm leading-6 text-vs-muted">{query ? "No matching options." : emptyLabel}</p>}
      </div>
      {footer && <div className="composer-picker-footer vs-scroll">{footer}</div>}
    </div>, portalRoot)}
  </>;
}
