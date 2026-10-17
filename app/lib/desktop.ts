export type DesktopBridge = {
  isDesktop: boolean;
  platform: string;
  pairComputer: (code: string) => Promise<{ ok: boolean; error?: string }>;
  /** Keys for AI tools, kept on this computer. Absent in older desktop apps. */
  secretNames?: () => Promise<{ ok: boolean; names: string[]; error?: string }>;
  setSecret?: (name: string, value: string) => Promise<{ ok: boolean; names?: string[]; error?: string }>;
  removeSecret?: (name: string) => Promise<{ ok: boolean; names?: string[]; error?: string }>;
};

export function desktopBridge(): DesktopBridge | undefined {
  if (typeof window === "undefined") return undefined;
  return (window as Window & { desktop?: DesktopBridge }).desktop;
}
