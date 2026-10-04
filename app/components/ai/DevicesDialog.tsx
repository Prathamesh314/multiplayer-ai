"use client";
import { openUserStream } from "../../lib/events/shared-client";

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
import { desktopBridge } from "../../lib/desktop";


export function DevicesDialog({ onClose }: { onClose: () => void }) {
  const [devices, setDevices] = useState<RunnerDevice[] | null>(null);
  const [pairing, setPairing] = useState<{ code: string; expiresAt: number } | null>(null);
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState<"pair" | "start" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [reloadVersion, setReloadVersion] = useState(0);
  // Devices present when the pairing code was minted — anything beyond these
  // appearing in a refresh is the new machine coming online.
  const [knownIds, setKnownIds] = useState<Set<string>>(() => new Set());

  useEffect(() => {
    let cancelled = false;
    const load = () =>
      fetchDevices().then((list) => {
        if (!cancelled) setDevices(list);
        return list;
      }).catch(() => {
        if (!cancelled) setError("Could not load your computers. Check your connection and try again.");
      });
    const stream = openUserStream(type => { if (type === "devices.changed") void load(); }, () => void load());
    return () => {
      cancelled = true;
      stream.close();
    };
  }, [reloadVersion]);

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

  async function pairDesktop() {
    if (!pairing) return;
    setBusy(true);
    setError(null);
    try {
      const result = await desktopBridge()?.pairComputer(pairing.code);
      if (!result?.ok) throw new Error(result?.error || "Desktop pairing is unavailable.");
      setDevices(await fetchDevices());
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not pair this desktop.");
    } finally {
      setBusy(false);
    }
  }

  const origin = typeof window !== "undefined" ? window.location.origin : "";
  // npm supplies the downloaded executable's PATH. A global install can fail
  // on permissions or leave its bin directory outside the user's shell PATH.
  const runnerCommand = `npx --yes --package="${origin}/downloads/multiplayer-ai-runner.tgz" multiplayer-ai-runner`;
  const startCommand = `${runnerCommand} start`;
  const pairCommand = pairing
    ? `${runnerCommand} pair --server "${origin}" --code ${pairing.code}`
    : "";

  function commandRow(id: "pair" | "start", label: string, command: string) {
    return (
      <div key={id} className="space-y-1">
        <p className="text-sm text-vs-muted">{label}</p>
        <div className="flex items-start gap-2">
          <code className="min-w-0 flex-1 break-all font-mono text-sm text-vs-fg">{command}</code>
          <GhostButton aria-label={`Copy ${id} command`} onClick={() => {
            void navigator.clipboard.writeText(command).then(() => {
              setCopied(id);
              setTimeout(() => setCopied(null), 1500);
            }).catch(() => setError("Could not copy. Select and copy the command manually."));
          }}>{copied === id ? "Copied" : "Copy"}</GhostButton>
        </div>
      </div>
    );
  }

  return (
    <Modal
      title="Your computers"
      description="The desktop app connects this computer automatically after sign-in. Your AI tasks run here using your installed AI tools. You can pause the connection from the desktop menu."
      width="max-w-xl"
      onClose={onClose}
      footer={<PrimaryButton onClick={onClose}>Done</PrimaryButton>}
    >
      {error && (
        <p role="alert" className="rounded-lg border border-vs-danger/40 bg-vs-danger/10 px-3 py-2 text-sm text-vs-danger">
          {error}
          <button type="button" onClick={() => { setError(null); setReloadVersion(version => version + 1); }} className="ml-2 underline">Try again</button>
        </p>
      )}

      {devices === null ? (
        <div className="flex justify-center py-8">
          {!error && <SpinnerIcon className="h-5 w-5 text-vs-muted" />}
        </div>
      ) : devices.length === 0 && !pairing ? (
        <p className="py-2 text-[13px] text-vs-muted">
          No computers connected yet. In the desktop app, the connection starts after sign-in. In a browser, use Connect a computer below.
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
          <div className="space-y-3 rounded-lg border border-vs-success/40 bg-vs-success/10 px-3 py-2 text-[13px]">
            <p className="text-vs-success">Paired — the new machine is in the list above. {desktopBridge()?.pairComputer ? "The desktop runner starts automatically." : "Start the runner below to bring it online."}</p>
            {!desktopBridge()?.pairComputer && <>
              {commandRow("start", "Start your computer connection", startCommand)}
              <p className="text-sm text-vs-muted">Keep this terminal open while you work. Use the same start command whenever you reconnect; you only need to pair once.</p>
            </>}
          </div>
        ) : (
          <div className="space-y-2 rounded-lg border border-vs-border bg-vs-editor p-3">
            {desktopBridge()?.pairComputer && (
              <div className="space-y-2 border-b border-vs-border pb-3">
                <PrimaryButton disabled={busy} onClick={() => void pairDesktop()}>
                  {busy ? <SpinnerIcon className="h-4 w-4" /> : null} Pair this desktop
                </PrimaryButton>
                <p className="text-sm text-vs-muted">Confirm in the native dialog to enable the bundled runner. No project checkout or npm command is needed. Git and your AI CLI must already be installed.</p>
              </div>
            )}
            <details open={!desktopBridge()?.pairComputer} className="space-y-3">
              <summary className="cursor-pointer text-sm text-vs-fg">Connect with the standalone runner</summary>
              <p className="text-sm leading-6 text-vs-muted">Run these commands from any folder. Install Node.js 22 or newer and Git first, plus your AI provider’s CLI. The commands download the runner automatically; no global installation or Multiplayer AI source code is needed.</p>
              {commandRow("pair", "1. Pair this computer once", pairCommand)}
              {commandRow("start", "2. Start your computer connection", startCommand)}
              <p className="text-sm leading-6 text-vs-muted">Keep the terminal open while you work. Run the start command again whenever you reconnect. If your terminal says npx is not found, install Node.js, then open a new terminal.</p>
            </details>
            <p className="text-[12px] text-vs-muted">
              The code is single-use and expires in ten minutes. This list updates the moment
              the machine connects.
            </p>
            <p className="text-sm leading-6 text-vs-muted">Your AI provider may still send requests to its cloud service.</p>
          </div>
        )
      ) : (
        <div>
          <PrimaryButton onClick={() => void startPairing()} disabled={busy || devices === null}>
            {busy ? <SpinnerIcon className="h-4 w-4" /> : null} Connect a computer
          </PrimaryButton>
        </div>
      )}
    </Modal>
  );
}
