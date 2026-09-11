export type DesktopBridge = {
  isDesktop: boolean;
  platform: string;
  pairComputer: (code: string) => Promise<{ ok: boolean; error?: string }>;
};

export function desktopBridge(): DesktopBridge | undefined {
  if (typeof window === "undefined") return undefined;
  return (window as Window & { desktop?: DesktopBridge }).desktop;
}
