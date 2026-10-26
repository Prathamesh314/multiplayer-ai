"use client";

/*
 * The bar under a chat's title: the views of the chat on the left (the
 * conversation, its briefing, its activity, the AI providers), rarer views in
 * "More", and what you do with the chat on the right (copy its link, fork it).
 * New views go in `items` or `more`, so the bar never turns back into a row of
 * loose buttons. As the panel narrows, labels fold away (the minor ones
 * first) and the icons stay; if it is narrower still, the actions wrap below
 * instead of overlapping.
 */

import { useEffect, useRef, useState, type ReactNode } from "react";
import { ChevronIcon, MoreIcon } from "../icons";

export type ChatNavItem = {
  id: string;
  label: string;
  icon: ReactNode;
  onSelect: () => void;
  /** A count beside the label, such as unread feedback, and what it counts ("unread"). */
  badge?: number | null;
  badgeLabel?: string;
  /** A dot on the icon: something here needs a look. */
  dot?: boolean;
  /** More detail on hover. */
  hint?: string;
  /** Opens a popover anchored here rather than a dialog. */
  popover?: boolean;
  /** Receives the button, for a popover to anchor to. */
  anchor?: (element: HTMLButtonElement | null) => void;
  accent?: boolean;
  /** Its label folds away first when the panel narrows. */
  minor?: boolean;
};

const tab = "inline-flex h-7 shrink-0 items-center gap-1.5 rounded-md px-2 text-[11.5px] font-medium whitespace-nowrap transition focus-visible:outline-2 focus-visible:outline-vs-accent";
const idle = "text-vs-muted hover:bg-vs-hover hover:text-vs-fg";
const current = "bg-vs-accent/15 text-vs-fg";

export function ChatNav({ items, more = [], active, actions }: {
  items: ChatNavItem[];
  more?: ChatNavItem[];
  /** The id of the view showing now. */
  active: string;
  actions?: ReactNode;
}) {
  return (
    <nav aria-label="Chat" className="ai-chat-nav @container flex min-w-0 shrink-0 flex-wrap items-center justify-between gap-x-2 gap-y-1 border-b border-vs-border">
      <div className="flex min-w-0 items-center gap-0.5">
        {items.map(({ anchor, ...item }) => <NavButton key={item.id} item={item} anchor={anchor} active={active === item.id} />)}
        {more.length > 0 && <MoreMenu items={more} active={active} />}
      </div>
      {actions && <div className="flex shrink-0 items-center gap-1">{actions}</div>}
    </nav>
  );
}

function NavButton({ item, anchor, active }: { item: Omit<ChatNavItem, "anchor">; anchor?: ChatNavItem["anchor"]; active: boolean }) {
  return (
    <button ref={anchor} type="button" onClick={item.onSelect} title={item.hint ?? item.label} aria-label={nameOf(item)}
      aria-current={active ? "true" : undefined} aria-haspopup={item.popover ? "dialog" : undefined} aria-expanded={item.popover ? active : undefined}
      className={`${tab} ${active ? current : item.accent ? "text-vs-accent hover:bg-vs-hover" : idle}`}>
      <span className="relative inline-flex">
        {item.icon}
        {item.dot && <span className="absolute -right-0.5 -top-0.5 h-1.5 w-1.5 rounded-full bg-vs-accent" aria-hidden />}
      </span>
      {/* The label folds away in a narrow panel; it stays the button's name. */}
      <span className={item.minor ? "sr-only @[54rem]:not-sr-only" : "sr-only @[36rem]:not-sr-only"}>{item.label}</span>
      {!!item.badge && <Badge count={item.badge} />}
    </button>
  );
}

/** "Feedback, 1 unread": the item's name with its count spelled out. */
const nameOf = (item: Omit<ChatNavItem, "anchor">) => item.badge ? `${item.label}, ${item.badge} ${item.badgeLabel ?? "new"}` : undefined;

function Badge({ count }: { count: number }) {
  return <span className="rounded-full bg-vs-accent px-1.5 text-[10px] leading-4 font-semibold text-white tabular-nums">{count}</span>;
}

/** The rarer views. Its dot says one of them is waiting for you. */
function MoreMenu({ items, active }: { items: ChatNavItem[]; active: string }) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const away = (event: PointerEvent) => { if (!root.current?.contains(event.target as Node)) setOpen(false); };
    const key = (event: KeyboardEvent) => { if (event.key === "Escape") setOpen(false); };
    document.addEventListener("pointerdown", away);
    document.addEventListener("keydown", key);
    return () => { document.removeEventListener("pointerdown", away); document.removeEventListener("keydown", key); };
  }, [open]);
  const shownHere = items.some(item => item.id === active);
  const waiting = items.reduce((sum, item) => sum + (item.badge ?? 0), 0);
  return (
    <div ref={root} className="relative">
      <button type="button" aria-haspopup="menu" aria-expanded={open} aria-label={waiting ? `More: ${waiting} waiting` : "More"} onClick={() => setOpen(value => !value)}
        className={`${tab} ${shownHere || open ? current : idle}`}>
        <span className="relative inline-flex">
          <MoreIcon className="h-3.5 w-3.5" />
          {waiting > 0 && <span className="absolute -right-0.5 -top-0.5 h-1.5 w-1.5 rounded-full bg-vs-accent" aria-hidden />}
        </span>
        <span className="hidden @[54rem]:inline">More</span>
        <ChevronIcon className={`h-2.5 w-2.5 transition ${open ? "-rotate-90" : "rotate-90"}`} />
      </button>
      {open && (
        <div role="menu" aria-label="More" className="absolute left-0 top-full z-30 mt-1 w-56 rounded-xl border border-vs-border bg-vs-panel p-1 shadow-[0_14px_40px_rgb(0_0_0_/_0.45)]">
          {items.map(item => (
            <button key={item.id} type="button" role="menuitem" title={item.hint} aria-label={nameOf(item)}
              onClick={() => { setOpen(false); item.onSelect(); }}
              className="flex w-full items-center gap-2.5 rounded-md px-2.5 py-1.5 text-left text-[12.5px] text-vs-fg transition hover:bg-vs-hover">
              <span className="text-vs-muted">{item.icon}</span>
              <span className="min-w-0 flex-1 truncate">{item.label}</span>
              {!!item.badge && <Badge count={item.badge} />}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/** A secondary action on the right: icon, with its label when there's room. */
export function ChatNavAction({ icon, label, onClick, title, primary = false, disabled = false }: {
  icon: ReactNode; label: string; onClick: () => void; title?: string; primary?: boolean; disabled?: boolean;
}) {
  return (
    <button type="button" onClick={onClick} title={title ?? label} disabled={disabled}
      className={primary
        ? "inline-flex h-7 shrink-0 items-center gap-1.5 rounded-md bg-vs-accent px-2.5 text-[11.5px] font-semibold whitespace-nowrap text-white transition hover:opacity-90 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-vs-accent disabled:opacity-50"
        : `${tab} ${idle} disabled:opacity-50`}>
      {icon}
      <span className={primary ? "sr-only @md:not-sr-only" : "sr-only @[54rem]:not-sr-only"}>{label}</span>
    </button>
  );
}
