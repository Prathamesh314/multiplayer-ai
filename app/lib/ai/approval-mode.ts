import type { PermissionMode } from "./runs";

/*
 * The approval mode a member last chose, so their next new chat starts the
 * same way on this device. Manual ("ask") when nothing is stored or browser
 * storage is unavailable.
 */
const KEY = "multicode.approvals.v1";

export function readApprovalMode(): PermissionMode {
  try {
    return typeof window !== "undefined" && window.localStorage.getItem(KEY) === "auto" ? "auto" : "ask";
  } catch {
    return "ask";
  }
}

export function rememberApprovalMode(mode: PermissionMode) {
  try { window.localStorage.setItem(KEY, mode); } catch { /* not remembered */ }
}
