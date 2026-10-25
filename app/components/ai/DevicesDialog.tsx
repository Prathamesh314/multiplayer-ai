"use client";

/*
 * Your computers: the machines that run your agents (docs/local-execution.md).
 *
 * Lists every paired device with liveness, lets any be revoked (effective on
 * its next request), and connects a new one two ways: the desktop app (it
 * connects by itself once you sign in) or a terminal (mint a code, show the
 * exact commands, and watch the list until the device appears).
 *
 * The trust model, stated where users grant it: a machine only ever executes
 * runs *its owner* started. Nobody else's prompts reach your hardware.
 */

import { UpdateComputerHelp } from "./UpdateComputerHelp";
import { runnerCommand } from "../../lib/runner/package";
import { useEffect, useState } from "react";
import { fetchComputerConnection, mintPairingCode, revokeDevice } from "../../lib/runner/client";
import type { RunnerDevice } from "../../lib/runner/client";
import { relativeTime } from "../../lib/format";
import { CheckIcon, ChevronIcon, ComputerIcon, SpinnerIcon, TerminalIcon } from "../icons";
import { GhostButton, Modal, PrimaryButton } from "../ui/Modal";
import { desktopBridge } from "../../lib/desktop";
import { useComputerConnection, type ComputerConnection } from "./useComputerConnection";

type Method = "desktop" | "terminal";

export function DevicesDialog({ onClose, onSetUpAi }: { onClose: () => void; onSetUpAi?: () => void }) {
  const connection = useComputerConnection();
  const { devices } = connection;
  const [method, setMethod] = useState<Method>("desktop");
  const [pairing, setPairing] = useState<{ code: string; expiresAt: number } | null>(null);
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState<"pair" | "start" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());
  // Devices present when the pairing code was minted — anything beyond these
  // appearing in a refresh is the new machine coming online.
  const [knownIds, setKnownIds] = useState<Set<string>>(() => new Set());

  const paired = pairing !== null ? (devices ?? []).find((device) => !knownIds.has(device.id)) ?? null : null;
  const expired = pairing !== null && !paired && now >= pairing.expiresAt;
  // The code's countdown ticks only while it can still be used.
  useEffect(() => {
    if (!pairing || paired || expired) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [pairing, paired, expired]);

  const desktop = !!desktopBridge()?.pairComputer;
  const connected = connection.status === "connected";
  const newOneConnected = !!paired && paired.online && paired.version === "2";
  const tray = typeof navigator !== "undefined" && /Mac/i.test(navigator.userAgent) ? "menu bar" : "system tray";

  /** `via`: the desktop tab connects this computer through the app; the terminal tab only needs the code. */
  async function startPairing(via: Method) {
    setBusy(true);
    setError(null);
    try {
      // The computers that exist now; the one that appears after is the new one.
      const existing = devices ?? (await fetchComputerConnection()).devices;
      setKnownIds(new Set(existing.map((device) => device.id)));
      const minted = await mintPairingCode();
      setPairing(minted);
      setNow(Date.now());
      if (desktop && via === "desktop") {
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

  const origin = typeof window !== "undefined" ? window.location.origin : "";
  // npm supplies the downloaded executable's PATH. A global install can fail
  // on permissions or leave its bin directory outside the user's shell PATH.
  const startCommand = runnerCommand(origin, "start");
  const pairCommand = pairing ? runnerCommand(origin, `pair --server "${origin}" --code ${pairing.code}`) : "";

  function copy(id: "pair" | "start", command: string) {
    void navigator.clipboard.writeText(command).then(() => {
      setCopied(id);
      setTimeout(() => setCopied(null), 1800);
    }).catch(() => setError("Could not copy. Select and copy the command manually."));
  }

  const connect = (
    <section aria-label="Connect a computer" className="space-y-4">
      <div role="tablist" aria-label="How to connect" className="grid grid-cols-2 gap-1 rounded-xl border border-vs-border bg-vs-editor p-1 text-[12.5px] font-medium">
        {([["desktop", desktop ? "This app" : "Desktop app", " (easiest)", ComputerIcon], ["terminal", "Terminal", " (npx)", TerminalIcon]] as const).map(([id, label, hint, Icon]) => (
          <button key={id} type="button" role="tab" aria-selected={method === id} onClick={() => {
            setMethod(id);
            // The terminal steps open with their pairing code ready; once a code exists,
            // an expired one is renewed with Get new code.
            if (id === "terminal" && !pairing && !busy) void startPairing("terminal");
          }}
            className={`flex items-center justify-center gap-2 rounded-lg px-2 py-2 transition ${method === id ? "bg-vs-active text-vs-fg shadow-sm" : "text-vs-muted hover:text-vs-fg"}`}>
            <Icon className="h-3.5 w-3.5 shrink-0" /><span>{label}<span className="hidden sm:inline">{hint}</span></span>
          </button>
        ))}
      </div>

      {method === "desktop" ? (
        <div role="tabpanel" aria-label="Desktop app" className="space-y-3">
          {desktop ? (
            <div className="space-y-2.5 rounded-xl border border-vs-border bg-vs-editor p-4">
              <PrimaryButton disabled={busy || devices === null} onClick={() => void startPairing("desktop")}>
                {busy ? <SpinnerIcon className="h-4 w-4" /> : null} Connect this computer
              </PrimaryButton>
              <p className="text-[12.5px] leading-5 text-vs-muted">Confirm in the dialog that opens to enable the runner built into this app. No npm command is needed. Git and your AI tool’s CLI must already be installed.</p>
            </div>
          ) : (
            <>
              <ol aria-label="Desktop app steps" className="grid gap-2.5 sm:grid-cols-3">
                <StepCard n={1} title={connection.status === "update" ? "Update & open" : "Install & open"}
                  body={connection.status === "update" ? "Install the latest Multicode AI app." : "Open Multicode AI on the computer you want to use."} />
                <StepCard n={2} title="Sign in" body="Use the same account as here. It connects by itself." />
                <StepCard n={3} title="Keep it running" body={`Leave it open and your computer awake; it stays in the ${tray}.`} />
              </ol>
              <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-vs-border bg-vs-editor p-3.5">
                <a href="/#download" target="_blank" rel="noreferrer" className="rounded-lg bg-vs-accent px-4 py-2 text-[13px] font-semibold text-vs-accent-fg transition hover:opacity-90">
                  {connection.status === "update" ? "Get the latest app" : "Get the desktop app"}
                </a>
                <span className="text-[11.5px] text-vs-muted">macOS, Windows & Linux</span>
              </div>
              <p className="text-[12px] leading-5 text-vs-muted">Paused? Choose <strong className="font-medium text-vs-fg">Resume runner</strong> from the app’s icon in the {tray}.</p>
            </>
          )}
        </div>
      ) : (
        <div role="tabpanel" aria-label="Terminal" className="space-y-3">
          <div className="flex flex-wrap items-center justify-between gap-2 text-[11.5px] text-vs-muted">
            <span>Needs Node.js 22+ · Git · your AI tool’s CLI</span>
            {pairing && !paired && !expired && (
              <span className="font-mono text-vs-accent" aria-label={`Code ${pairing.code}, expires in ${countdown(pairing.expiresAt - now)}`}>
                Code {pairing.code} · {countdown(pairing.expiresAt - now)}
              </span>
            )}
          </div>

          <CommandCard step={1} title="Pair this computer (once)" done={!!paired}>
            {paired ? (
              <p className="px-3.5 py-3 text-[12.5px] text-vs-muted"><strong className="font-medium text-vs-fg">{paired.name}</strong> is linked to your account.</p>
            ) : expired ? (
              <div className="space-y-2.5 px-3.5 py-3 text-[12.5px]">
                <p role="status" className="text-vs-warn">This code has expired. Get a new one and run the pair command again.</p>
                <GhostButton disabled={busy} onClick={() => void startPairing("terminal")}>Get new code</GhostButton>
              </div>
            ) : pairing ? (
              <Command id="pair" command={pairCommand} copied={copied === "pair"} onCopy={copy} />
            ) : (
              busy ? (
                <p role="status" className="flex items-center gap-2 px-3.5 py-3 text-[12.5px] text-vs-muted"><SpinnerIcon className="h-3.5 w-3.5" /> Creating your pairing code…</p>
              ) : (
                <div className="flex flex-wrap items-center justify-between gap-3 px-3.5 py-3 text-[12.5px] text-vs-muted">
                  <span>The pairing code could not be created. Already paired? Skip to step 2.</span>
                  <GhostButton onClick={() => void startPairing("terminal")}>Try again</GhostButton>
                </div>
              )
            )}
          </CommandCard>

          <CommandCard step={2} title="Start the connection" done={newOneConnected}>
            {paired?.online && paired.version !== "2"
              ? <p className="px-3.5 py-3 text-[12.5px] text-vs-warn">That computer runs an older version. Update it, then run this again.</p>
              : null}
            <Command id="start" command={startCommand} copied={copied === "start"} onCopy={copy} />
          </CommandCard>

          <p className="text-[12px] leading-5 text-vs-muted">Run them from any folder; npx downloads the runner, nothing is installed globally. Keep the terminal open while you work, and run the start command again to reconnect. If npx isn’t found, install Node.js and open a new terminal.</p>
        </div>
      )}
      <p className="text-[11.5px] leading-4 text-vs-muted">Only your own chats run on your computer. Your AI provider may still send requests to its cloud service.</p>
    </section>
  );

  return (
    <Modal
      title="Your computers"
      description="Connect a computer to send AI messages and run tasks with Claude Code, Codex or Gemini. You can read saved chats and browse files without one."
      width="max-w-xl"
      onClose={onClose}
      footer={<>
        <ConnectionStatus connection={connection} paired={paired} pairing={!!pairing && !expired} />
        {!connected && <GhostButton disabled={connection.checking} onClick={() => { setError(null); void connection.refresh(); }}>{connection.checking ? "Checking…" : "Check connection"}</GhostButton>}
        <GhostButton onClick={onClose}>Close</GhostButton>
        {connected && onSetUpAi && <PrimaryButton onClick={onSetUpAi}>Next: Set up AI</PrimaryButton>}
      </>}
    >
      {(error || connection.error) && (
        <p role="alert" className="rounded-lg border border-vs-danger/40 bg-vs-danger/10 px-3 py-2 text-sm text-vs-danger">
          {error || connection.error}
          <button type="button" disabled={connection.checking} onClick={() => { setError(null); void connection.refresh(); }} className="ml-2 underline">Check connection again</button>
        </p>
      )}

      {newOneConnected && (
        <div role="status" className="flex items-start gap-2.5 rounded-lg border border-vs-success/40 bg-vs-success/10 px-3 py-2.5 text-[13px]">
          <CheckIcon className="mt-0.5 h-4 w-4 shrink-0 text-vs-success" />
          <p className="text-vs-success">Computer connected. You can now set up AI and continue your chats.</p>
        </div>
      )}

      {!connected && (connection.status === "offline" || connection.status === "update") && (
        <div className="space-y-1">
          <h3 className="text-[14px] font-semibold">{connection.status === "offline" ? "Bring your computer back online" : "Update your computer connection"}</h3>
          <p className="text-[12.5px] leading-5 text-vs-muted">{connection.status === "offline"
            ? "Open the desktop app, or run the start command again on that computer."
            : "Your computer’s app or runner is older than this workspace. Install the latest version, then reconnect."}</p>
        </div>
      )}

      {devices === null ? (
        <div className="flex justify-center py-6">
          {!error && !connection.error && <SpinnerIcon className="h-5 w-5 text-vs-muted" />}
        </div>
      ) : devices.length > 0 && (
        <>
          {/* Older apps can't ask in the chat before a command or link, so the agent is refused instead. */}
          {devices.some((device) => device.online && !device.supportsPermissions) && <UpdateComputerHelp />}
          <ul aria-label="Your computers" className="space-y-2">
            {devices.map((device) => (
              <li key={device.id} className="flex items-center gap-3 rounded-lg border border-vs-border px-3.5 py-2.5">
                <span className={`h-2 w-2 shrink-0 rounded-full ${device.online ? "bg-vs-success" : "bg-vs-muted/40"}`} title={device.online ? "Online" : "Offline"} />
                <div className="min-w-0 flex-1">
                  <p className="truncate text-[14px] text-vs-fg">{device.name}</p>
                  <p className="text-[12px] text-vs-muted">
                    {device.online
                      ? device.version !== "2" || !device.supportsPermissions ? "Update needed" : "Connected"
                      : device.lastSeenAt
                        ? `Offline · last connected ${relativeTime(device.lastSeenAt)}`
                        : "Paired · not connected yet"}
                    {device.git === "missing" ? <span className="text-vs-danger"> · Git missing</span> : device.git ? ` · Git ${device.git}` : ""}
                    {device.platform ? ` · ${device.platform}` : ""}
                    {device.version ? ` · v${device.version}` : ""}
                  </p>
                </div>
                <GhostButton onClick={() => void revoke(device)} disabled={busy}>Remove</GhostButton>
              </li>
            ))}
          </ul>
        </>
      )}

      {/* Connected: connecting another computer is still there, folded away. */}
      {connected && !pairing ? (
        <details className="group rounded-xl border border-vs-border">
          <summary className="flex cursor-pointer list-none items-center justify-between px-4 py-3 text-[13px] font-medium text-vs-fg">Connect another computer<ChevronIcon className="h-3.5 w-3.5 text-vs-muted transition-transform group-open:rotate-90" /></summary>
          <div className="border-t border-vs-border p-4">{connect}</div>
        </details>
      ) : connect}
    </Modal>
  );
}

/** One step of the desktop app's setup, as a small card. */
function StepCard({ n, title, body }: { n: number; title: string; body: string }) {
  return (
    <li className="rounded-xl border border-vs-border bg-vs-editor p-3.5">
      <p className="flex items-center gap-2 text-[12.5px] font-semibold text-vs-fg">
        <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full border border-vs-accent/60 text-[10.5px] text-vs-accent">{n}</span>
        {title}
      </p>
      <p className="mt-1.5 text-[11.5px] leading-4 text-vs-muted">{body}</p>
    </li>
  );
}

/** A terminal step: its title (checked once done) and its command or state. */
function CommandCard({ step, title, done, children }: { step: number; title: string; done: boolean; children: React.ReactNode }) {
  return (
    <div className="overflow-hidden rounded-xl border border-vs-border bg-vs-editor">
      <p className="flex items-center gap-2 border-b border-vs-border bg-vs-panel px-3.5 py-2 text-[12.5px] font-medium text-vs-fg">
        {done
          ? <span className="flex h-4 w-4 items-center justify-center rounded-full bg-vs-success/15 text-vs-success"><CheckIcon className="h-2.5 w-2.5" /></span>
          : <span className="text-vs-muted">{step}.</span>}
        {title}
      </p>
      {children}
    </div>
  );
}

function Command({ id, command, copied, onCopy }: { id: "pair" | "start"; command: string; copied: boolean; onCopy: (id: "pair" | "start", command: string) => void }) {
  return (
    <div className="flex items-start gap-2 px-3.5 py-3">
      <code className="vs-scroll min-w-0 flex-1 overflow-x-auto whitespace-nowrap pb-1 font-mono text-[12px] leading-5 text-vs-fg">{command}</code>
      <button type="button" aria-label={`Copy ${id} command`} onClick={() => onCopy(id, command)}
        className="shrink-0 rounded-md border border-vs-border bg-vs-panel px-2.5 py-1 text-[11.5px] text-vs-fg transition hover:bg-vs-hover">
        {copied ? "Copied ✓" : "Copy"}
      </button>
    </div>
  );
}

/** The footer's one line on where things stand: green only once a computer is connected. */
function ConnectionStatus({ connection, paired, pairing }: { connection: ComputerConnection; paired: RunnerDevice | null; pairing: boolean }) {
  const name = connection.computer?.name;
  // A computer being connected right now comes first, even with another one online.
  const [tone, text] =
    paired && !(paired.online && paired.version === "2") ? ["wait", `${paired.name} is paired · waiting for it to connect…`]
    : pairing && !paired ? ["wait", "Waiting for your computer to pair…"]
    : connection.status === "connected" ? ["ok", `Connected · ${name ?? "your computer"}`]
    : connection.status === "error" ? ["error", "Couldn’t check the connection"]
    : connection.status === "checking" ? ["idle", "Checking…"]
    : connection.status === "update" ? ["warn", `${name ?? "Your computer"} needs an update`]
    : connection.status === "offline" ? ["idle", `${name ?? "Your computer"} is offline`]
    : ["wait", "Waiting for a computer to connect…"];
  return (
    <p role="status" className="mr-auto flex min-w-0 items-center gap-2 text-[12px] text-vs-muted">
      <span className={`h-2 w-2 shrink-0 rounded-full ${tone === "ok" ? "bg-vs-success" : tone === "error" ? "bg-vs-danger" : tone === "warn" ? "bg-vs-warn" : tone === "wait" ? "animate-pulse bg-vs-warn" : "bg-vs-muted/40"}`} />
      <span className="truncate">{text}</span>
    </p>
  );
}

function countdown(ms: number): string {
  const seconds = Math.max(0, Math.ceil(ms / 1000));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}
