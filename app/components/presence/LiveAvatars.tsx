"use client";

/*
 * Who else is here, the way Google Docs and Figma show it: overlapping
 * avatars in each person's colour, a name on hover, and "+N" opening the
 * full list. Colours come from the user id (lib/people.ts), so a person is the
 * same colour in everyone's browser and in the editor's carets.
 */

import { useEffect, useRef, useState } from "react";
import { colorOf, initialsOf } from "../../lib/people";

export type LivePerson = { userId: string; displayName: string; handle?: string | null; avatarUrl?: string | null };

const SIZES = { xs: "h-[18px] w-[18px] text-[8px]", sm: "h-6 w-6 text-[10px]", md: "h-8 w-8 text-[11px]" } as const;

export function LiveAvatars({ people, label, max = 4, size = "sm", title }: {
  people: LivePerson[];
  /** What they are doing, for the hover and list: "Viewing this chat", "Online". */
  label: string;
  max?: number;
  size?: keyof typeof SIZES;
  /** Heading of the full list. */
  title?: string;
}) {
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (event: MouseEvent | KeyboardEvent) => {
      if (event instanceof KeyboardEvent ? event.key === "Escape" : !box.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", close);
    document.addEventListener("keydown", close);
    return () => { document.removeEventListener("mousedown", close); document.removeEventListener("keydown", close); };
  }, [open]);

  if (people.length === 0) return null;
  const shown = people.slice(0, max);
  const extra = people.length - shown.length;
  const summary = `${people.length} ${people.length === 1 ? "person" : "people"} · ${label.toLowerCase()}`;

  return (
    <div ref={box} className="relative flex items-center" role="group" aria-label={summary}>
      <button type="button" onClick={() => setOpen((value) => !value)} aria-expanded={open} aria-haspopup="dialog" aria-label={`${summary}. Show everyone`}
        className="flex items-center -space-x-0.5 rounded-full p-1 outline-none focus-visible:ring-2 focus-visible:ring-vs-accent">
        {shown.map((person) => <Face key={person.userId} person={person} label={label} size={size} />)}
        {extra > 0 && (
          <span className={`relative inline-flex items-center justify-center rounded-full bg-vs-hover font-semibold text-vs-fg ring-2 ring-vs-panel ${SIZES[size]}`}>+{extra}</span>
        )}
      </button>
      {open && (
        <div role="dialog" aria-label={title ?? label} className="absolute right-0 top-full z-50 mt-2 w-64 overflow-hidden rounded-xl border border-vs-border bg-vs-panel shadow-xl">
          <p className="border-b border-vs-border px-3 py-2 text-[11px] font-medium uppercase tracking-wider text-vs-muted">{title ?? label} · {people.length}</p>
          <ul className="vs-scroll max-h-72 overflow-y-auto py-1">
            {people.map((person) => (
              <li key={person.userId} className="flex items-center gap-2.5 px-3 py-1.5">
                <Avatar person={person} size="sm" />
                <div className="min-w-0 flex-1">
                  <p className="truncate text-[13px] text-vs-fg">{person.displayName}</p>
                  {person.handle && <p className="truncate text-[11px] text-vs-muted">@{person.handle}</p>}
                </div>
                <span className="h-2 w-2 shrink-0 rounded-full bg-vs-success" aria-label="Online" />
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

function Face({ person, label, size }: { person: LivePerson; label: string; size: keyof typeof SIZES }) {
  return (
    <span className="presence-pop group relative inline-flex transition hover:z-10 hover:-translate-y-0.5">
      <Avatar person={person} size={size} ring />
      {/* A name card on hover or focus, like a collaborator's chip in Docs. */}
      <span role="tooltip" className="pointer-events-none absolute left-1/2 top-full z-50 mt-2 hidden -translate-x-1/2 whitespace-nowrap rounded-lg bg-vs-fg px-2 py-1 text-[11px] text-vs-editor shadow-lg group-hover:block">
        <span className="font-medium">{person.displayName}</span>
        <span className="opacity-70"> · {label}</span>
      </span>
    </span>
  );
}

export function Avatar({ person, size = "sm", ring = false }: { person: LivePerson; size?: keyof typeof SIZES; ring?: boolean }) {
  const color = colorOf(person.userId);
  const frame = `relative inline-flex shrink-0 items-center justify-center overflow-hidden rounded-full font-semibold ${SIZES[size]} ${ring ? `ring-2 ${color.ring} ring-offset-1 ring-offset-vs-panel` : ""}`;
  if (person.avatarUrl) {
    // eslint-disable-next-line @next/next/no-img-element -- remote profile pictures of any size
    return <span className={frame}><img src={person.avatarUrl} alt="" className="h-full w-full object-cover" referrerPolicy="no-referrer" /></span>;
  }
  return <span className={`${frame} ${color.dot} text-white`}>{initialsOf(person.displayName)}</span>;
}
