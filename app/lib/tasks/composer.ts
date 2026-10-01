/** Remove the assignment tag once, preserving mentions within the task itself. */
export function assignmentDraft(text: string, handle: string): { body: string } | null {
  const parts = text.split(/(\s+)/);
  const tag = `@${handle}`.toLowerCase();
  const index = parts.findIndex(part => part.toLowerCase() === tag);
  if (index === -1) return null;
  parts.splice(index, 1);
  return { body: parts.join("").trim() };
}
