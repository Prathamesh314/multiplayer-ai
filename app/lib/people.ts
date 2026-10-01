/**
 * Turning an account into the two things the collaboration UI needs: a stable
 * colour and a short label.
 *
 * The colour is derived from the user id, not assigned in order of arrival, so
 * the same person is the same colour in everybody's browser and stays that
 * colour across reloads. Assigning by position in a list would give two people
 * different colours for each other.
 */
const PALETTE = [
  { chip: "bg-sky-500/15 text-sky-700 dark:text-sky-300", ring: "ring-sky-500", dot: "bg-sky-500", text: "text-sky-700 dark:text-sky-300" },
  { chip: "bg-violet-500/15 text-violet-700 dark:text-violet-300", ring: "ring-violet-500", dot: "bg-violet-500", text: "text-violet-700 dark:text-violet-300" },
  { chip: "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300", ring: "ring-emerald-500", dot: "bg-emerald-500", text: "text-emerald-700 dark:text-emerald-300" },
  { chip: "bg-amber-500/15 text-amber-700 dark:text-amber-300", ring: "ring-amber-500", dot: "bg-amber-500", text: "text-amber-700 dark:text-amber-300" },
  { chip: "bg-rose-500/15 text-rose-700 dark:text-rose-300", ring: "ring-rose-500", dot: "bg-rose-500", text: "text-rose-700 dark:text-rose-300" },
  { chip: "bg-cyan-500/15 text-cyan-700 dark:text-cyan-300", ring: "ring-cyan-500", dot: "bg-cyan-500", text: "text-cyan-700 dark:text-cyan-300" },
  { chip: "bg-fuchsia-500/15 text-fuchsia-700 dark:text-fuchsia-300", ring: "ring-fuchsia-500", dot: "bg-fuchsia-500", text: "text-fuchsia-700 dark:text-fuchsia-300" },
  { chip: "bg-lime-500/15 text-lime-700 dark:text-lime-300", ring: "ring-lime-500", dot: "bg-lime-500", text: "text-lime-700 dark:text-lime-300" },
];

export type PersonColor = (typeof PALETTE)[number];

export function colorOf(userId: string): PersonColor {
  let hash = 0;
  for (let index = 0; index < userId.length; index += 1) {
    hash = (hash * 31 + userId.charCodeAt(index)) | 0;
  }
  return PALETTE[Math.abs(hash) % PALETTE.length];
}

export function initialsOf(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return "?";
  if (words.length === 1) return words[0].slice(0, 2).toUpperCase();
  return (words[0][0] + words[1][0]).toUpperCase();
}

/** "Alice", not "Alice Doe" — the badges are small and the surname rarely helps. */
export function firstNameOf(name: string): string {
  return name.trim().split(/\s+/)[0] || name;
}
