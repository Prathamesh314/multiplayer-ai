/** Whether the terminal may run here, and what shell/cwd it reports. */
export type TerminalStatus = {
  enabled: boolean;
  reason?: string;
  /**
   * `computer`: shells open on the member's own computer, in the chat's
   * worktree, through their runner. `server`: on the machine serving the app
   * (only where runners cannot connect, such as a development server without Redis).
   */
  location: "computer" | "server";
  /** The member's computer that terminals open on, when `location` is `computer`. */
  device?: string;
  cwd: string;
  shell: string;
  platform: string;
};

/** Control messages POSTed to the pty route: keystrokes, a resize, or a kill. */
export type PtyControl =
  | { id: string; type: "input"; data: string }
  | { id: string; type: "resize"; cols: number; rows: number }
  | { id: string; type: "kill" };
