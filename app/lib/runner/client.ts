/*
 * Browser client for the runner-device surface: the Devices dialog lists,
 * pairs, and revokes through these. Types come from the routes themselves so
 * the two sides cannot drift (type-only imports — nothing server-side runs
 * in the browser bundle).
 */

import type { RunnerDevice } from "./devices";
import type { DevicesResponse } from "../../api/runner/devices/route";
import type { PairingCodeResponse } from "../../api/runner/pairing/route";

export type { RunnerDevice };

export async function fetchComputerConnection(signal?: AbortSignal): Promise<DevicesResponse> {
  const response = await fetch("/api/runner/devices", {
    cache: "no-store",
    signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(10_000)]) : AbortSignal.timeout(10_000),
  });
  if (!response.ok) throw new Error(response.status === 401
    ? "Your sign-in has expired. Sign in again to check your computer connection."
    : "We couldn’t check your computer connection. Check your internet connection and try again.");
  const data = await response.json() as DevicesResponse;
  if (!Array.isArray(data.devices)) throw new Error("We couldn’t check your computer connection. Please try again.");
  return { devices: data.devices, requiresComputer: data.requiresComputer !== false };
}

export async function fetchDevices(): Promise<RunnerDevice[]> {
  return (await fetchComputerConnection()).devices;
}

/** Mint a pairing code — shown once, expires in ten minutes, single use. */
export async function mintPairingCode(): Promise<PairingCodeResponse> {
  const response = await fetch("/api/runner/pairing", { method: "POST" });
  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as { error?: string } | null;
    throw new Error(body?.error ?? "Could not create a pairing code.");
  }
  return (await response.json()) as PairingCodeResponse;
}

export async function revokeDevice(deviceId: string): Promise<void> {
  const response = await fetch(`/api/runner/devices/${encodeURIComponent(deviceId)}`, {
    method: "DELETE",
  });
  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as { error?: string } | null;
    throw new Error(body?.error ?? "Could not revoke that device.");
  }
}
