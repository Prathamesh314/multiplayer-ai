/**
 * An id for this browser tab, stable for as long as it is open.
 *
 * Two tabs must look like two participants — one saving should still update the
 * other — so this is per tab rather than per user or per device.
 */
let tabId: string | null = null;

export function currentTabId(): string {
  tabId ??= crypto.randomUUID();
  return tabId;
}
