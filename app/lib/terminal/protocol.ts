/** Whether the terminal may run here, and what shell/cwd it reports. */
export type TerminalStatus = {
  enabled: boolean;
  reason?: string;
  cwd: string;
  shell: string;
  platform: string;
};

/** Control messages POSTed to the pty route: keystrokes, a resize, or a kill. */
export type PtyControl =
  | { id: string; type: "input"; data: string }
  | { id: string; type: "resize"; cols: number; rows: number }
  | { id: string; type: "kill" };
