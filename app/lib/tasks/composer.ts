/**
 * The task in a draft addressed to a teammate: the draft without its first
 * `#handle` (or `@handle`) tag, keeping any later mentions in the task itself.
 * Null when the draft no longer tags them.
 */
export function assignmentDraft(text: string, handle: string): { body: string } | null {
  const parts = text.split(/(\s+)/);
  const tags = [`#${handle}`.toLowerCase(), `@${handle}`.toLowerCase()];
  const index = parts.findIndex(part => tags.includes(part.toLowerCase()));
  if (index === -1) return null;
  // Take one neighbouring space with it, so "Please #bob check" reads "Please check".
  const before = index > 0 && index < parts.length - 1 ? 1 : 0;
  parts.splice(index - before, 1 + before);
  return { body: parts.join("").trim() };
}
