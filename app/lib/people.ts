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
  { chip: "bg-sky-600 text-white", ring: "ring-sky-500", dot: "bg-sky-500", text: "text-sky-500" },
  { chip: "bg-violet-600 text-white", ring: "ring-violet-500", dot: "bg-violet-500", text: "text-violet-500" },
  { chip: "bg-emerald-600 text-white", ring: "ring-emerald-500", dot: "bg-emerald-500", text: "text-emerald-500" },
  { chip: "bg-amber-600 text-white", ring: "ring-amber-500", dot: "bg-amber-500", text: "text-amber-500" },
  { chip: "bg-rose-600 text-white", ring: "ring-rose-500", dot: "bg-rose-500", text: "text-rose-500" },
  { chip: "bg-cyan-600 text-white", ring: "ring-cyan-500", dot: "bg-cyan-500", text: "text-cyan-500" },
  { chip: "bg-fuchsia-600 text-white", ring: "ring-fuchsia-500", dot: "bg-fuchsia-500", text: "text-fuchsia-500" },
  { chip: "bg-lime-600 text-white", ring: "ring-lime-500", dot: "bg-lime-500", text: "text-lime-500" },
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
