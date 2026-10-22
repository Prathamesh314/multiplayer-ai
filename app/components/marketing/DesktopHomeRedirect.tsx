"use client";

import { useEffect } from "react";
import { desktopBridge } from "../../lib/desktop";

/**
 * The desktop app is the workspace and never shows this page. Current apps are
 * redirected before it loads (proxy.ts); this catches older ones, which don't
 * identify themselves to the server.
 */
export function DesktopHomeRedirect() {
  useEffect(() => {
    if (desktopBridge()?.isDesktop) window.location.replace("/workspace");
  }, []);
  return null;
}
