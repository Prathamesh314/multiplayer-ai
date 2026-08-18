"use client";

import { colorOf, firstNameOf } from "../../lib/people";
import type { FilePresence } from "./usePeople";

/**
 * Other people's carets, drawn where they actually are.
 *
 * The geometry has to match `CodeEditor` exactly or the markers drift: the same
 * 20px line box, the same 8px top padding, and `ch` units for the column, which
 * are exact because the editor is monospace. These constants are the coupling —
 * change the editor's leading and this must change with it.
 */
const LINE_HEIGHT = 20;
const TOP_PADDING = 8;

export function RemoteCarets({ people }: { people: FilePresence[] }) {
  if (people.length === 0) return null;

  return (
    // Purely decorative, and must never swallow a click meant for the textarea
    // sitting underneath it.
    <div aria-hidden className="pointer-events-none absolute inset-0 z-20 overflow-hidden">
      {people.map((person) => {
        const color = colorOf(person.userId);
        const top = TOP_PADDING + (person.line - 1) * LINE_HEIGHT;
        // Line 1 has no room above it, so its label hangs below instead.
        const labelAbove = person.line > 1;

        return (
          <div
            key={person.userId}
            className="absolute transition-all duration-150 ease-out"
            style={{ top, left: `${person.column - 1}ch` }}
          >
            <span
              className={`absolute block w-[2px] ${color.dot}`}
              style={{ height: LINE_HEIGHT }}
            />
            <span
              className={`absolute whitespace-nowrap rounded px-1 py-px text-[9px] font-semibold leading-[12px] ${color.chip}`}
              style={
                labelAbove
                  ? { bottom: LINE_HEIGHT - 6, left: -1 }
                  : { top: LINE_HEIGHT - 2, left: -1 }
              }
            >
              {firstNameOf(person.name)}
            </span>
          </div>
        );
      })}
    </div>
  );
}
