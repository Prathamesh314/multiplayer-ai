"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { openUserStream } from "../../lib/events/shared-client";
import { fetchComputerConnection } from "../../lib/runner/client";
import type { DevicesResponse } from "../../api/runner/devices/route";

export type ComputerStatus = "checking" | "error" | "not-connected" | "offline" | "update" | "connected";
export type ComputerConnection = ReturnType<typeof useComputerConnection>;

export function useComputerConnection() {
  const [data, setData] = useState<DevicesResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);
  const request = useRef<AbortController | null>(null);

  const refresh = useCallback(async () => {
    request.current?.abort();
    const controller = new AbortController();
    request.current = controller;
    setChecking(true);
    try {
      const response = await fetchComputerConnection(controller.signal);
      if (!controller.signal.aborted) { setData(response); setError(null); }
    } catch (cause) {
      if (!controller.signal.aborted) setError(cause instanceof Error && !(cause instanceof TypeError) && cause.name !== "TimeoutError"
        ? cause.message : "We couldn’t check your computer connection. Check your internet connection and try again.");
    } finally {
      if (!controller.signal.aborted) setChecking(false);
    }
  }, []);

  useEffect(() => {
    const load = () => { if (!document.hidden) void refresh(); };
    load();
    const stream = openUserStream(type => { if (type === "devices.changed") load(); }, load);
    // The runner stream broadcasts disconnections after the heartbeat window.
    // Focus/visibility also recheck after this browser has been asleep.
    window.addEventListener("focus", load);
    document.addEventListener("visibilitychange", load);
    return () => {
      request.current?.abort();
      stream.close();
      window.removeEventListener("focus", load);
      document.removeEventListener("visibilitychange", load);
    };
  }, [refresh]);

  const devices = data?.devices ?? null;
  const online = devices?.filter(device => device.online) ?? [];
  const computer = online.find(device => device.version === "2") ?? online[0] ?? devices?.[0];
  const status: ComputerStatus = error ? "error" : !data ? "checking"
    : online.some(device => device.version === "2") ? "connected" : online.length ? "update"
    : devices?.length ? "offline" : "not-connected";
  return { status, devices, computer, error, checking, refresh };
}
