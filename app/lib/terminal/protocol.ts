/** Events streamed from the terminal route as newline-delimited JSON. */
export type TerminalEvent =
  | { t: "start"; pid: number | undefined; cwd: string; command: string }
  | { t: "out"; d: string }
  | { t: "err"; d: string }
  | { t: "cwd"; path: string }
  | { t: "notice"; message: string }
  | { t: "exit"; code: number | null; signal: string | null; ms: number };

export type TerminalStatus = {
  enabled: boolean;
  reason?: string;
  cwd: string;
  shell: string;
  platform: string;
};

export type RunRequest = {
  command: string;
  cwd: string;
  runId: string;
};

/** Total bytes of output kept per command before the run is cut short. */
export const MAX_OUTPUT_BYTES = 2 * 1024 * 1024;
/** Hard wall-clock limit for a single command. */
export const MAX_RUN_MS = 10 * 60 * 1000;
