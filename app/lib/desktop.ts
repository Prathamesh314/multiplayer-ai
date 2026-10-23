export type DesktopBridge = {
  isDesktop: boolean;
  platform: string;
  pairComputer: (code: string) => Promise<{ ok: boolean; error?: string }>;
  /** Keys for AI tools, kept on this computer. Absent in older desktop apps. */
  secretNames?: () => Promise<{ ok: boolean; names: string[]; error?: string }>;
  setSecret?: (name: string, value: string) => Promise<{ ok: boolean; names?: string[]; error?: string }>;
  removeSecret?: (name: string) => Promise<{ ok: boolean; names?: string[]; error?: string }>;
  /** A newer release from the website. Absent in older desktop apps. */
  updateState?: () => Promise<DesktopUpdate>;
  onUpdate?: (callback: (state: DesktopUpdate) => void) => () => void;
  installUpdate?: () => Promise<{ ok: boolean; opened?: "download"; error?: string }>;
  showUpdateChanges?: () => Promise<void>;
};

/** "ready" once the new installer is downloaded and verified; `changes` when there is a list of what changed. */
export type DesktopUpdate = { status: "idle" | "downloading" | "ready"; build: string | null; changes: boolean };

export function desktopBridge(): DesktopBridge | undefined {
  if (typeof window === "undefined") return undefined;
  return (window as Window & { desktop?: DesktopBridge }).desktop;
}
