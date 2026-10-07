"use client";

import { colorOf, firstNameOf, initialsOf } from "../../lib/people";
import type { SessionMember } from "../../lib/session/types";
import type { FilePresence } from "./usePeople";

/**
 * The session roster, as a stack of avatars. Online people come first and keep
 * full contrast; everyone else is dimmed rather than hidden, so the stack shows
 * the team rather than only whoever happens to be awake.
 */
export function PeopleStack({ members }: { members: SessionMember[] }) {
  if (members.length === 0) return null;

  const ordered = [...members].sort(
    (a, b) => Number(b.online) - Number(a.online) || a.displayName.localeCompare(b.displayName),
  );
  const shown = ordered.slice(0, 5);
  const extra = ordered.length - shown.length;

  return (
    <div className="flex items-center">
      <div className="flex -space-x-1.5">
        {shown.map((member) => (
          <PersonChip key={member.userId} member={member} />
        ))}
      </div>
      {extra > 0 && (
        <span className="ml-1.5 text-[12px] text-vs-muted" title={`${extra} more`}>
          +{extra}
        </span>
      )}
    </div>
  );
}

function PersonChip({ member }: { member: SessionMember }) {
  const color = colorOf(member.userId);

  return (
    <span
      className="relative inline-flex shrink-0"
      title={`${member.displayName} · ${member.role}${member.online ? " · online" : " · away"}`}
    >
      <span
        className={`inline-flex h-6 w-6 items-center justify-center rounded-full text-[11px] font-semibold ring-2 ring-vs-chrome ${color.chip} ${
          member.online ? "" : "opacity-40"
        }`}
      >
        {initialsOf(member.displayName)}
      </span>
      {member.online && (
        <span className="absolute -bottom-0.5 -right-0.5 h-2 w-2 rounded-full border-2 border-vs-chrome bg-vs-success" />
      )}
    </span>
  );
}

/**
 * Who is typing in one file, right now.
 *
 * `compact` is for the explorer, where a row is 22px and only a coloured dot
 * fits; the full form carries the name, which is what makes it readable in the
 * tab strip.
 */
export function EditingBadge({
  people,
  compact,
}: {
  people: FilePresence[];
  compact?: boolean;
}) {
  if (people.length === 0) return null;

  const label =
    people.length === 1
      ? `${people[0].name} is editing this file`
      : `${people.map((p) => p.name).join(", ")} are editing this file`;

  if (compact) {
    return (
      <span className="ml-auto flex shrink-0 items-center gap-0.5 pl-1" title={label}>
        {people.slice(0, 3).map((person) => (
          <span
            key={person.userId}
            className={`h-1.5 w-1.5 animate-pulse rounded-full ${colorOf(person.userId).dot}`}
          />
        ))}
      </span>
    );
  }

  return (
    <span className="flex shrink-0 items-center gap-1" title={label}>
      {people.slice(0, 3).map((person) => (
        <span
          key={person.userId}
          className={`inline-flex h-4 items-center gap-1 rounded-full px-1.5 text-[10px] font-semibold ${colorOf(person.userId).chip}`}
        >
          <span className="h-1 w-1 animate-pulse rounded-full bg-current opacity-80" />
          {firstNameOf(person.name)}
        </span>
      ))}
    </span>
  );
}
