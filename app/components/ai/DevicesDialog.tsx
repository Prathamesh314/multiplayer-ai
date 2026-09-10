"use client";

/*
 * Your computers: the machines that run your agents (docs/local-execution.md).
 *
 * Lists every paired device with liveness, lets any be revoked (effective on
 * its next request), and drives pairing: mint a code, show the exact command
 * to run on the new machine, and watch the list until the device appears —
 * the moment it does, the pairing is visibly complete.
 *
 * The trust model, stated where users grant it: a machine only ever executes
 * runs *its owner* started. Nobody else's prompts reach your hardware.
 */

import { useEffect, useState } from "react";
import { fetchDevices, mintPairingCode, revokeDevice } from "../../lib/runner/client";
import type { RunnerDevice } from "../../lib/runner/client";
import { relativeTime } from "../../lib/format";
import { SpinnerIcon } from "../icons";
import { GhostButton, Modal, PrimaryButton } from "../ui/Modal";

/** Refresh cadence while the dialog is open; pairing completion shows itself. */
const POLL_MS = 5_000;

export function DevicesDialog({ onClose }: { onClose: () => void }) {
  const [devices, setDevices] = useState<RunnerDevice[] | null>(null);
  const [pairing, setPairing] = useState<{ code: string; expiresAt: number } | null>(null);
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Devices present when the pairing code was minted — anything beyond these
  // appearing in a refresh is the new machine coming online.
  const [knownIds, setKnownIds] = useState<Set<string>>(() => new Set());

  useEffect(() => {
    let cancelled = false;
    const load = () =>
      fetchDevices().then((list) => {
        if (!cancelled) setDevices(list);
        return list;
      });
    void load();
    const timer = setInterval(() => void load(), POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, []);

  const paired =
    pairing !== null && (devices ?? []).some((device) => !knownIds.has(device.id));

  async function startPairing() {
    setBusy(true);
    setError(null);
    try {
      setKnownIds(new Set((devices ?? []).map((device) => device.id)));
      const minted = await mintPairingCode();
      setPairing(minted);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not create a pairing code.");
    } finally {
      setBusy(false);
    }
  }

  async function revoke(device: RunnerDevice) {
    setBusy(true);
    setError(null);
    try {
      await revokeDevice(device.id);
      setDevices((current) => (current ?? []).filter((entry) => entry.id !== device.id));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not revoke that device.");
    } finally {
      setBusy(false);
    }
  }

  const pairCommand = pairing
    ? `npm run runner -- pair --server ${typeof window !== "undefined" ? window.location.origin : ""} --code ${pairing.code}`
    : "";

  return (
    <Modal
      title="Your computers"
      description="Paired machines run your agent chats locally — your CPU, your AI logins. A machine only ever executes runs you started."
      width="max-w-xl"
      onClose={onClose}
      footer={<PrimaryButton onClick={onClose}>Done</PrimaryButton>}
    >
      {error && (
        <p className="rounded-lg border border-vs-danger/40 bg-vs-danger/10 px-3 py-2 text-sm text-vs-danger">
          {error}
        </p>
      )}

      {devices === null ? (
        <div className="flex justify-center py-8">
          <SpinnerIcon className="h-5 w-5 text-vs-muted" />
        </div>
      ) : devices.length === 0 && !pairing ? (
        <p className="py-2 text-[13px] text-vs-muted">
          No computers paired yet — your runs execute in the cloud. Pair one to run agents on
          your own machine.
        </p>
      ) : (
        <ul className="space-y-2">
          {devices.map((device) => (
            <li
              key={device.id}
              className="flex items-center gap-3 rounded-lg border border-vs-border px-3.5 py-2.5"
            >
              <span
                className={`h-2 w-2 shrink-0 rounded-full ${device.online ? "bg-vs-success" : "bg-vs-muted/40"}`}
                title={device.online ? "Online" : "Offline"}
              />
              <div className="min-w-0 flex-1">
                <p className="truncate text-[14px] text-vs-fg">{device.name}</p>
                <p className="text-[12px] text-vs-muted">
                  {device.online
                    ? "Online now"
                    : device.lastSeenAt
                      ? `Last seen ${relativeTime(device.lastSeenAt)}`
                      : "Never connected"}
                  {device.platform ? ` · ${device.platform}` : ""}
                  {device.version ? ` · v${device.version}` : ""}
                </p>
              </div>
              <GhostButton onClick={() => void revoke(device)} disabled={busy}>
                Revoke
              </GhostButton>
            </li>
          ))}
        </ul>
      )}

      {pairing ? (
        paired ? (
          <p className="rounded-lg border border-vs-success/40 bg-vs-success/10 px-3 py-2 text-[13px] text-vs-success">
            Paired — the new machine is in the list above.
          </p>
        ) : (
          <div className="space-y-2 rounded-lg border border-vs-border bg-vs-editor p-3">
            <p className="text-[12px] uppercase tracking-wider text-vs-muted">
              Run this on the computer being paired
            </p>
            <div className="flex items-center gap-2">
              <code className="min-w-0 flex-1 truncate font-mono text-[12px] text-vs-fg">
                {pairCommand}
              </code>
              <GhostButton
                onClick={() => {
                  void navigator.clipboard.writeText(pairCommand).then(() => {
                    setCopied(true);
                    setTimeout(() => setCopied(false), 1500);
                  });
                }}
              >
                {copied ? "Copied" : "Copy"}
              </GhostButton>
            </div>
            <p className="text-[12px] text-vs-muted">
              The code is single-use and expires in ten minutes. This list updates the moment
              the machine connects.
            </p>
          </div>
        )
      ) : (
        <div>
          <PrimaryButton onClick={() => void startPairing()} disabled={busy || devices === null}>
            {busy ? <SpinnerIcon className="h-4 w-4" /> : null} Pair this computer
          </PrimaryButton>
        </div>
      )}
    </Modal>
  );
}
