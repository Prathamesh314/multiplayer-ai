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

import { UpdateComputerHelp } from "./UpdateComputerHelp";
import { runnerCommand } from "../../lib/runner/package";
import { useEffect, useState } from "react";
import { mintPairingCode, revokeDevice } from "../../lib/runner/client";
import type { RunnerDevice } from "../../lib/runner/client";
import { relativeTime } from "../../lib/format";
import { CheckIcon, SpinnerIcon } from "../icons";
import { GhostButton, Modal, PrimaryButton } from "../ui/Modal";
import { desktopBridge } from "../../lib/desktop";
import { useComputerConnection } from "./useComputerConnection";


export function DevicesDialog({ onClose, onSetUpAi }: { onClose: () => void; onSetUpAi?: () => void }) {
  const connection = useComputerConnection();
  const { devices } = connection;
  const [pairing, setPairing] = useState<{ code: string; expiresAt: number } | null>(null);
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState<"pair" | "start" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [expired, setExpired] = useState(false);
  // Devices present when the pairing code was minted — anything beyond these
  // appearing in a refresh is the new machine coming online.
  const [knownIds, setKnownIds] = useState<Set<string>>(() => new Set());

  useEffect(() => {
    if (!pairing) return;
    const timer = setTimeout(() => setExpired(true), Math.max(0, pairing.expiresAt - Date.now()));
    return () => clearTimeout(timer);
  }, [pairing]);

  const paired = pairing !== null && (devices ?? []).find((device) => !knownIds.has(device.id));
  const desktop = !!desktopBridge()?.pairComputer;
  const connected = connection.status === "connected";

  async function startPairing() {
    setBusy(true);
    setError(null);
    try {
      setKnownIds(new Set((devices ?? []).map((device) => device.id)));
      const minted = await mintPairingCode();
      setPairing(minted);
      setExpired(false);
      if (desktop) {
        const result = await desktopBridge()!.pairComputer(minted.code);
        if (!result.ok) throw new Error(result.error || "Could not connect this computer. Please try again.");
        await connection.refresh();
      }
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
      await connection.refresh();
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
      await connection.refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not pair this desktop.");
    } finally {
      setBusy(false);
    }
  }

  const origin = typeof window !== "undefined" ? window.location.origin : "";
  // npm supplies the downloaded executable's PATH. A global install can fail
  // on permissions or leave its bin directory outside the user's shell PATH.
  const startCommand = runnerCommand(origin, "start");
  const pairCommand = pairing
    ? runnerCommand(origin, `pair --server "${origin}" --code ${pairing.code}`)
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
      description="Connect a computer to send AI messages and run tasks. You can read saved chats and browse files without one."
      width="max-w-xl"
      onClose={onClose}
      footer={<><GhostButton onClick={onClose}>Close</GhostButton>{connected && onSetUpAi && <PrimaryButton onClick={onSetUpAi}>Next: Set up AI</PrimaryButton>}</>}
    >
      {(error || connection.error) && (
        <p role="alert" className="rounded-lg border border-vs-danger/40 bg-vs-danger/10 px-3 py-2 text-sm text-vs-danger">
          {error || connection.error}
          <button type="button" disabled={connection.checking} onClick={() => { setError(null); void connection.refresh(); }} className="ml-2 underline">Check connection again</button>
        </p>
      )}

      {!connected && <div className="space-y-3 rounded-xl border border-vs-border bg-vs-editor p-4">
        <h3 className="text-base font-semibold">{connection.status === "offline" ? "Bring your computer back online" : connection.status === "update" ? "Update your computer connection" : "Start with the desktop app"}</h3>
        <ol className="list-decimal space-y-2 pl-5 text-sm leading-6 text-vs-muted">
          <li>{connection.status === "update" ? "Install the latest Multicode AI desktop app." : "Open the Multicode AI desktop app on the computer you want to use."}</li>
          <li>Sign in with the same account you use here. The app connects automatically.</li>
          <li>Keep the app open and your computer awake. If paused, choose Resume runner from the app’s desktop menu.</li>
        </ol>
        <div className="flex flex-wrap items-center gap-3">
          {!desktop && <a href="/#download" target="_blank" rel="noreferrer" className="rounded-lg bg-vs-accent px-4 py-2 text-sm font-medium text-vs-accent-fg hover:opacity-90">Get the desktop app</a>}
          <GhostButton disabled={connection.checking} onClick={() => void connection.refresh()}>{connection.checking ? "Checking…" : "Check connection"}</GhostButton>
        </div>
        <p className="text-sm leading-6 text-vs-muted">Once connected, set up an AI tool such as Claude Code or Codex on that computer. Your AI account stays on your computer.</p>
      </div>}

      {devices === null ? (
        <div className="flex justify-center py-8">
          {!error && !connection.error && <SpinnerIcon className="h-5 w-5 text-vs-muted" />}
        </div>
      ) : devices.length === 0 && !pairing ? (
        <p className="py-2 text-[13px] text-vs-muted">
          No computer connected yet. This page updates automatically when your computer comes online.
        </p>
      ) : (
        <>
        {/* Older apps can't ask in the chat before a command or link, so the agent is refused instead. */}
        {devices.some((device) => device.online && !device.supportsPermissions) && <UpdateComputerHelp />}
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
                    ? device.version !== "2" || !device.supportsPermissions ? "Update needed" : "Connected"
                    : device.lastSeenAt
                      ? `Offline · last connected ${relativeTime(device.lastSeenAt)}`
                      : "Paired · not connected yet"}
                  {device.platform ? ` · ${device.platform}` : ""}
                  {device.version ? ` · v${device.version}` : ""}
                </p>
              </div>
              <GhostButton onClick={() => void revoke(device)} disabled={busy}>
                Remove
              </GhostButton>
            </li>
          ))}
        </ul>
        </>
      )}

      {pairing ? (
        paired ? (
          // Pairing (step 1) only links the computer to this account; it is
          // connected once its runner is started (step 2) and checks in. Only
          // that is green, so the first command never looks like the last.
          paired.online && paired.version === "2" ? (
            <div role="status" className="flex items-start gap-2.5 rounded-lg border border-vs-success/40 bg-vs-success/10 px-3 py-2.5 text-[13px]">
              <CheckIcon className="mt-0.5 h-4 w-4 shrink-0 text-vs-success" />
              <p className="text-vs-success">Computer connected. You can now set up AI and continue your chats.</p>
            </div>
          ) : (
            <div className="space-y-3 rounded-lg border border-vs-border bg-vs-editor p-3 text-[13px]">
              <ol aria-label="Connection steps" className="space-y-3">
                <li className="flex gap-2.5">
                  <StepMark state="done" />
                  <div className="min-w-0 flex-1">
                    <p className="font-medium text-vs-fg">Paired</p>
                    <p className="text-[12px] text-vs-muted">{paired.name} is linked to your account. It isn’t connected yet.</p>
                  </div>
                </li>
                <li className="flex gap-2.5">
                  <StepMark state={paired.online ? "warn" : "current"} number={2} />
                  <div className="min-w-0 flex-1 space-y-2">
                    <p className="font-medium text-vs-fg">{desktop ? "Starting the connection" : "Start your computer connection"}</p>
                    {paired.online ? (
                      <p className="text-[12px] text-vs-warn">That computer runs an older version. Update it, then start it again.</p>
                    ) : desktop ? (
                      <p className="text-[12px] text-vs-muted">The desktop app starts it for you. Keep the app open.</p>
                    ) : (
                      <>
                        {commandRow("start", "Run this on the same computer, in a terminal:", startCommand)}
                        <p className="text-[12px] text-vs-muted">Keep the terminal open while you work. Use the same command whenever you reconnect; you only pair once.</p>
                      </>
                    )}
                    {!paired.online && (
                      <p role="status" className="flex items-center gap-2 text-[12px] text-vs-muted">
                        <SpinnerIcon className="h-3.5 w-3.5" /> Waiting for your computer to connect…
                      </p>
                    )}
                  </div>
                </li>
              </ol>
            </div>
          )
        ) : expired ? (
          <div role="status" className="space-y-3 rounded-lg border border-vs-warn/40 p-4 text-sm">
            <p>This connection code has expired. Get a new code and try again.</p>
            <PrimaryButton disabled={busy} onClick={() => void startPairing()}>Get new connection code</PrimaryButton>
          </div>
        ) : (
          <div className="space-y-2 rounded-lg border border-vs-border bg-vs-editor p-3">
            {desktop && (
              <div className="space-y-2 border-b border-vs-border pb-3">
                <PrimaryButton disabled={busy} onClick={() => void pairDesktop()}>
                  {busy ? <SpinnerIcon className="h-4 w-4" /> : null} Connect this computer
                </PrimaryButton>
                <p className="text-sm text-vs-muted">Confirm in the native dialog to enable the bundled runner. No project checkout or npm command is needed. Git and your AI CLI must already be installed.</p>
              </div>
            )}
            <details open={!desktop} className="space-y-3">
              <summary className="cursor-pointer text-sm text-vs-fg">Connect using a terminal</summary>
              <p className="text-sm leading-6 text-vs-muted">Run these commands from any folder. Install Node.js 22 or newer and Git first, plus your AI provider’s CLI. The commands download the runner automatically; no global installation or Multicode AI source code is needed.</p>
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
        desktop ? <PrimaryButton onClick={() => void startPairing()} disabled={busy || devices === null}>
          {busy ? <SpinnerIcon className="h-4 w-4" /> : null} Connect this computer
        </PrimaryButton> : <details className="space-y-3 rounded-xl border border-vs-border p-4">
          <summary className="cursor-pointer text-sm font-medium">Use a terminal instead (advanced)</summary>
          {(devices?.length ?? 0) > 0 && <div className="space-y-2">
            <p className="text-sm text-vs-muted">Already paired from a terminal? Run this on that computer to reconnect. Keep the terminal open.</p>
            {commandRow("start", "Reconnect your computer", startCommand)}
          </div>}
          <GhostButton onClick={() => void startPairing()} disabled={busy || devices === null}>
            {busy ? "Creating code…" : "Connect a new computer with commands"}
          </GhostButton>
        </details>
      )}
    </Modal>
  );
}

/** A step's marker: a check once done, its number while it is the one to do. */
function StepMark({ state, number }: { state: "done" | "current" | "warn"; number?: number }) {
  if (state === "done") {
    return <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-vs-success/15 text-vs-success"><CheckIcon className="h-3 w-3" /></span>;
  }
  return (
    <span className={`flex h-5 w-5 shrink-0 items-center justify-center rounded-full border text-[11px] font-semibold ${state === "warn" ? "border-vs-warn text-vs-warn" : "border-vs-accent text-vs-accent"}`}>
      {number}
    </span>
  );
}
