"use client";

import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import type { PickedSource } from "../../lib/folder";
import { readDroppedFolder, scanDirectoryHandle, scanFileList } from "../../lib/scan";
import { takeFolder } from "../../lib/session/handoff";
import type { Session } from "../../lib/session/types";
import type { ScanResult } from "../../lib/types";
import { ActivityBar } from "./ActivityBar";
import { AiPanel } from "./AiPanel";
import type { Caret } from "./CodeEditor";
import type { Buffer } from "./EditorArea";
import { EditorArea } from "./EditorArea";
import { ExplorerPanel } from "./ExplorerPanel";
import { InviteDialog } from "./InviteDialog";
import { Resizer } from "./Resizer";
import { RowResizer } from "./RowResizer";
import { StatusBar } from "./StatusBar";
import { TeamChatPanel } from "./TeamChatPanel";
import { TerminalPanel } from "./TerminalPanel";
import { TopBar } from "./TopBar";
import { WelcomeView } from "./WelcomeView";

// The File System Access API only exists on the client, so the value has to
// come through a store that reports `false` during server rendering.
const noopSubscribe = () => () => {};
const hasPicker = () => !!window.showDirectoryPicker;
const noPicker = () => false;

export function Workspace({ session }: { session: Session }) {
  const router = useRouter();
  const inputRef = useRef<HTMLInputElement>(null);
  const supportsPicker = useSyncExternalStore(noopSubscribe, hasPicker, noPicker);
  const [inviteOpen, setInviteOpen] = useState(false);

  const [picked, setPicked] = useState<PickedSource | null>(null);
  const [result, setResult] = useState<ScanResult | null>(null);
  const [scanning, setScanning] = useState(false);
  const [progress, setProgress] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [includeIgnored, setIncludeIgnored] = useState(false);
  const [dragging, setDragging] = useState(false);

  const [tabs, setTabs] = useState<string[]>([]);
  const [activePath, setActivePath] = useState<string | null>(null);
  const [buffers, setBuffers] = useState<Map<string, Buffer>>(() => new Map());
  const [caret, setCaret] = useState<Caret>({ line: 1, column: 1 });

  const [chatOpen, setChatOpen] = useState(true);
  const [explorerOpen, setExplorerOpen] = useState(true);
  const [aiOpen, setAiOpen] = useState(true);
  const [terminalOpen, setTerminalOpen] = useState(false);
  const [chatWidth, setChatWidth] = useState(250);
  const [explorerWidth, setExplorerWidth] = useState(270);
  const [aiWidth, setAiWidth] = useState(320);
  const [terminalHeight, setTerminalHeight] = useState(260);

  // Ctrl+Shift+Z toggles the terminal; Ctrl+` also works, as in VS Code.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      // Ctrl only, never Cmd: ⇧⌘Z is redo on macOS and stays that way.
      if (!event.ctrlKey || event.altKey) return;

      // `code` rather than `key`: Shift turns the key into "Z" and non-US
      // layouts can report something else entirely.
      const isToggle =
        (event.shiftKey && event.code === "KeyZ") || (!event.shiftKey && event.key === "`");
      if (!isToggle) return;

      event.preventDefault();
      setTerminalOpen((previous) => !previous);
    };

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  const scan = useCallback(async (source: PickedSource, withIgnored: boolean) => {
    setScanning(true);
    setProgress(0);
    setError(null);
    try {
      const options = { includeIgnored: withIgnored, onProgress: setProgress };
      const scanned =
        source.kind === "handle"
          ? await scanDirectoryHandle(
              source.handle,
              source.origin === "drop" ? "drop" : "picker",
              options,
            )
          : await scanFileList(source.files, source.origin === "drop" ? "drop" : "input", options);
      setResult(scanned);
    } catch (cause) {
      setResult(null);
      setError(cause instanceof Error ? cause.message : "Could not read that folder.");
    } finally {
      setScanning(false);
    }
  }, []);

  const start = useCallback(
    async (source: PickedSource) => {
      setPicked(source);
      // A new folder invalidates every open buffer.
      setTabs([]);
      setActivePath(null);
      setBuffers(new Map());
      await scan(source, includeIgnored);
    },
    [includeIgnored, scan],
  );

  // A folder chosen in the create dialog is waiting for this session. Reading it
  // is a pull from an external store; the scan is deferred a microtask so it
  // does not set state inside the effect body. `takeFolder` clears the entry, so
  // a repeated effect run (StrictMode, or a rescan toggle) will not scan twice.
  useEffect(() => {
    const handed = takeFolder(session.id);
    if (!handed) return;
    queueMicrotask(() => void start(handed));
  }, [session.id, start]);

  async function openPicker() {
    if (!window.showDirectoryPicker) {
      inputRef.current?.click();
      return;
    }
    try {
      const handle = await window.showDirectoryPicker({ mode: "read" });
      await start({ kind: "handle", handle, origin: "picker" });
    } catch (cause) {
      // The user closing the dialog is not an error worth showing.
      if (cause instanceof DOMException && cause.name === "AbortError") return;
      setError(cause instanceof Error ? cause.message : "Could not open that folder.");
    }
  }

  async function onDrop(event: React.DragEvent) {
    event.preventDefault();
    setDragging(false);
    try {
      const dropped = await readDroppedFolder(event.dataTransfer);
      if (!dropped) {
        setError("Drop a folder, not a single file.");
        return;
      }
      await start(
        dropped.kind === "handle"
          ? { kind: "handle", handle: dropped.handle, origin: "drop" }
          : { kind: "files", files: dropped.files, origin: "drop" },
      );
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not read the dropped folder.");
    }
  }

  async function onInputChange(event: React.ChangeEvent<HTMLInputElement>) {
    const files = [...(event.target.files ?? [])];
    event.target.value = "";
    if (files.length === 0) return;
    await start({ kind: "files", files, origin: "input" });
  }

  async function openFile(path: string) {
    setActivePath(path);
    setCaret({ line: 1, column: 1 });
    setTabs((previous) => (previous.includes(path) ? previous : [...previous, path]));

    // Already loaded (or loading): keep any unsaved edits.
    if (buffers.has(path)) return;

    setBuffers((previous) =>
      new Map(previous).set(path, {
        original: "",
        text: "",
        size: 0,
        binary: false,
        truncated: false,
        loading: true,
      }),
    );

    const content = await result?.readFile(path);
    setBuffers((previous) =>
      new Map(previous).set(path, {
        original: content?.text ?? "",
        text: content?.text ?? "",
        size: content?.size ?? 0,
        binary: content?.binary ?? false,
        truncated: content?.truncated ?? false,
        loading: false,
        error: content ? undefined : "The file could not be read from disk.",
      }),
    );
  }

  function closeTab(path: string) {
    setTabs((previous) => {
      const next = previous.filter((candidate) => candidate !== path);
      if (path === activePath) setActivePath(next.at(-1) ?? null);
      return next;
    });
    setBuffers((previous) => {
      const next = new Map(previous);
      next.delete(path);
      return next;
    });
  }

  function editBuffer(path: string, text: string) {
    setBuffers((previous) => {
      const buffer = previous.get(path);
      if (!buffer) return previous;
      return new Map(previous).set(path, { ...buffer, text });
    });
  }

  async function toggleIgnored(next: boolean) {
    setIncludeIgnored(next);
    if (picked) await scan(picked, next);
  }

  const activeBuffer = activePath ? buffers.get(activePath) : undefined;

  return (
    <div
      className="flex h-dvh flex-col overflow-hidden bg-vs-editor text-vs-fg"
      onDragOver={(event) => {
        event.preventDefault();
        setDragging(true);
      }}
      onDragLeave={(event) => {
        // Ignore bubbling leaves from children.
        if (event.currentTarget === event.target) setDragging(false);
      }}
      onDrop={onDrop}
    >
      <TopBar
        session={session}
        onInvite={() => setInviteOpen(true)}
        onLeave={() => router.push("/")}
        folderName={result?.rootName ?? null}
        branch={result?.git.branch ?? null}
        isGit={!!result?.git.isGit}
        chatOpen={chatOpen}
        explorerOpen={explorerOpen}
        aiOpen={aiOpen}
        terminalOpen={terminalOpen}
        onToggleChat={() => setChatOpen(!chatOpen)}
        onToggleExplorer={() => setExplorerOpen(!explorerOpen)}
        onToggleAi={() => setAiOpen(!aiOpen)}
        onToggleTerminal={() => setTerminalOpen(!terminalOpen)}
        onOpenFolder={openPicker}
      />

      <input
        ref={inputRef}
        type="file"
        multiple
        webkitdirectory=""
        directory=""
        onChange={onInputChange}
        className="hidden"
      />

      <div className="flex min-h-0 flex-1">
        <ActivityBar
          chatOpen={chatOpen}
          explorerOpen={explorerOpen}
          aiOpen={aiOpen}
          terminalOpen={terminalOpen}
          onToggleChat={() => setChatOpen(!chatOpen)}
          onToggleExplorer={() => setExplorerOpen(!explorerOpen)}
          onToggleAi={() => setAiOpen(!aiOpen)}
          onToggleTerminal={() => setTerminalOpen(!terminalOpen)}
        />

        {chatOpen && (
          <>
            <div style={{ width: chatWidth }} className="min-h-0 shrink-0">
              <TeamChatPanel onClose={() => setChatOpen(false)} />
            </div>
            <Resizer width={chatWidth} onResize={setChatWidth} min={200} max={440} />
          </>
        )}

        {explorerOpen && result && (
          <>
            <div style={{ width: explorerWidth }} className="min-h-0 shrink-0">
              <ExplorerPanel
                key={`${result.rootName}:${includeIgnored}`}
                result={result}
                activePath={activePath}
                scanning={scanning}
                includeIgnored={includeIgnored}
                onToggleIgnored={toggleIgnored}
                onOpenFile={openFile}
                onOpenFolder={openPicker}
                onClose={() => setExplorerOpen(false)}
              />
            </div>
            <Resizer width={explorerWidth} onResize={setExplorerWidth} min={200} max={520} />
          </>
        )}

        <div className="flex min-h-0 min-w-0 flex-1 flex-col">
          <EditorArea
            tabs={tabs}
            activePath={activePath}
            buffers={buffers}
            onSelectTab={(path) => {
              setActivePath(path);
              setCaret({ line: 1, column: 1 });
            }}
            onCloseTab={closeTab}
            onChange={editBuffer}
            onCaretChange={setCaret}
            emptyState={
              <WelcomeView
                dragging={dragging}
                scanning={scanning}
                progress={progress}
                supportsPicker={supportsPicker}
                error={error}
                hasFolder={!!result}
                onOpenPicker={openPicker}
                onOpenInput={() => inputRef.current?.click()}
              />
            }
          />

          {terminalOpen && (
            <>
              <RowResizer height={terminalHeight} onResize={setTerminalHeight} />
              <div style={{ height: terminalHeight }} className="flex min-h-0 shrink-0">
                <TerminalPanel onClose={() => setTerminalOpen(false)} />
              </div>
            </>
          )}
        </div>

        {aiOpen && (
          <>
            <Resizer width={aiWidth} onResize={setAiWidth} min={260} max={520} invert />
            <div style={{ width: aiWidth }} className="min-h-0 shrink-0">
              <AiPanel activePath={activePath} onClose={() => setAiOpen(false)} />
            </div>
          </>
        )}
      </div>

      <StatusBar
        result={result}
        activePath={activePath}
        activeText={activeBuffer && !activeBuffer.loading && !activeBuffer.binary ? activeBuffer.text : null}
        caret={caret}
      />

      {inviteOpen && <InviteDialog session={session} onClose={() => setInviteOpen(false)} />}
    </div>
  );
}
