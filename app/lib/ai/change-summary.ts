/**
 * Older chats stored a "Changed N files (+A −R)" list as a message after each
 * run. The Changes tab shows that now, so chats no longer store it and skip the
 * ones already saved.
 */
export function isChangeSummary(text: string): boolean {
  return /^Changed \d+ files? \(\+\d+ [−-]\d+\)/.test(text);
}
