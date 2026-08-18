"use client";

import { useRouter } from "next/navigation";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import type { PickedSource } from "../../lib/folder";
import { readDroppedFolder, scanDirectoryHandle, scanFileList } from "../../lib/scan";
import { openSessionStream } from "../../lib/events/client";
import { notifyEditing } from "../../lib/session/client";
import type { FileSavedEvent } from "../../lib/events/types";
import type { ChatMessage } from "../../lib/session/types";
import { startHeartbeat } from "../../lib/presence/client";
import { takeFolder } from "../../lib/session/handoff";
import {
  createSaver,
  scanSession,
  seedSession,
  type SeedProgress,
} from "../../lib/session/remote";
import { canEdit, type Session, type SessionRepo } from "../../lib/session/types";
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
import { usePeople } from "./usePeople";
import { WelcomeView } from "./WelcomeView";

type SaveState = "idle" | "saving" | "saved" | "error";

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

  // Once a repo exists the browser is no longer the owner of this code: the
  // session repo is, and `result` is a view onto it.
  const [repo, setRepo] = useState<SessionRepo | null>(session.repo);
  const [seeding, setSeeding] = useState<SeedProgress | null>(null);
  const [saveState, setSaveState] = useState<SaveState>("idle");

  // A viewer may open everything and change nothing. The server refuses their
  // writes regardless; this stops the editor from pretending otherwise.
  const readOnly = !canEdit(session.myRole);

  const [live, setLive] = useState(false);
  /** Files a teammate changed under an edit of ours, which we refuse to discard. */
  const [conflicts, setConflicts] = useState<Map<string, string>>(() => new Map());
  /** Set when a broadcast names a path we have never seen. */
  const [treeStale, setTreeStale] = useState(false);

  // Enabled unconditionally: the roster and chat matter before a folder is up.
  const people = usePeople(session.id, true);
  /** Messages arriving over the stream, handed to the chat panel to merge. */
  const [incoming, setIncoming] = useState<ChatMessage[]>([]);

  const [tabs, setTabs] = useState<string[]>([]);
  const [activePath, setActivePath] = useState<string | null>(null);
  const [buffers, setBuffers] = useState<Map<string, Buffer>>(() => new Map());
  const [caret, setCaret] = useState<Caret>({ line: 1, column: 1 });

  // Mirrored into refs so the event handler can read current values without
  // becoming a new function on every keystroke — which would tear down and
  // reopen the SSE connection each time.
  const buffersRef = useRef(buffers);
  const resultRef = useRef(result);
  const caretRef = useRef(caret);

  const [chatOpen, setChatOpen] = useState(true);
  const [explorerOpen, setExplorerOpen] = useState(true);
  const [aiOpen, setAiOpen] = useState(true);
  const [terminalOpen, setTerminalOpen] = useState(false);
  const [chatWidth, setChatWidth] = useState(250);
  const [explorerWidth, setExplorerWidth] = useState(270);
  const [aiWidth, setAiWidth] = useState(320);
  const [terminalHeight, setTerminalHeight] = useState(260);

  /**
   * Typing has no turn boundary to commit on, so it gets a debounced one. This
   * is what keeps "a session never holds uncommitted state" true for people as
   * well as for agents.
   */
  const saver = useMemo(
    () =>
      createSaver(
        session.id,
        (path, saved, headSha) => {
          setRepo((previous) => (previous ? { ...previous, headSha } : previous));
          setSaveState("saved");
          setBuffers((previous) => {
            const buffer = previous.get(path);
            if (!buffer) return previous;
            // Only clear the dirty marker if the buffer has not moved on since
            // this save was sent; another save is already queued if it has.
            if (buffer.text !== saved) return previous;
            return new Map(previous).set(path, { ...buffer, original: saved });
          });
        },
        (message) => {
          setSaveState("error");
          setError(message);
        },
      ),
    [session.id],
  );

  // Nothing in flight may be dropped on the way out.
  useEffect(() => {
    const onHide = () => void saver.flush();
    window.addEventListener("pagehide", onHide);
    return () => {
      window.removeEventListener("pagehide", onHide);
      void saver.flush();
    };
  }, [saver]);

  useEffect(() => {
    buffersRef.current = buffers;
  }, [buffers]);

  useEffect(() => {
    resultRef.current = result;
  }, [result]);

  useEffect(() => {
    caretRef.current = caret;
  }, [caret]);

  /**
   * Moving the cursor is presence too, not just typing — otherwise a marker
   * sticks at the last character someone typed while they read elsewhere in
   * the file. The throttle keeps this from being chatty.
   */
  const trackCaret = useCallback(
    (next: Caret) => {
      setCaret(next);
      if (repo && !readOnly && activePath) {
        notifyEditing(session.id, activePath, next.line, next.column);
      }
    },
    [repo, readOnly, activePath, session.id],
  );

  // One heartbeat per open tab, for as long as this session is open. The tab
  // being open is what "online" means, so it starts and stops with the mount.
  useEffect(() => {
    const beat = startHeartbeat({ sessionId: session.id, orgId: session.orgId });
    return () => beat.stop();
  }, [session.id, session.orgId]);

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

  const scan = useCallback(
    async (source: PickedSource, withIgnored: boolean): Promise<ScanResult | null> => {
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
            : await scanFileList(
                source.files,
                source.origin === "drop" ? "drop" : "input",
                options,
              );
        setResult(scanned);
        return scanned;
      } catch (cause) {
        setResult(null);
        setError(cause instanceof Error ? cause.message : "Could not read that folder.");
        return null;
      } finally {
        setScanning(false);
      }
    },
    [],
  );

  /**
   * Uploads a locally scanned folder into the session repo, then swaps `result`
   * for a repo-backed one. After this the local folder is never read again —
   * handles die with the tab, and a teammate joining later has no access to it.
   */
  const publish = useCallback(
    async (scanned: ScanResult) => {
      setSeeding({ uploaded: 0, total: 0 });
      setError(null);
      try {
        const { repo: created, skipped } = await seedSession(session.id, scanned, setSeeding);
        setRepo(created);
        // The folder is no longer the source of truth, so drop the handle: a
        // rescan from here would silently diverge from the committed tree.
        setPicked(null);
        setResult(await scanSession({ ...session, repo: created }));
        if (skipped.length > 0) {
          setError(
            `${skipped.length} file(s) were too large or had unusable names and were left out of the session.`,
          );
        }
      } catch (cause) {
        setError(
          cause instanceof Error ? cause.message : "Could not upload the folder to this session.",
        );
      } finally {
        setSeeding(null);
      }
    },
    [session],
  );

  const start = useCallback(
    async (source: PickedSource) => {
      setPicked(source);
      // A new folder invalidates every open buffer.
      setTabs([]);
      setActivePath(null);
      setBuffers(new Map());
      const scanned = await scan(source, includeIgnored);
      if (scanned) await publish(scanned);
    },
    [includeIgnored, publish, scan],
  );

  // A folder chosen in the create dialog is waiting for this session. Reading it
  // is a pull from an external store; the scan is deferred a microtask so it
  // does not set state inside the effect body. `takeFolder` clears the entry, so
  // a repeated effect run (StrictMode, or a rescan toggle) will not scan twice.
  useEffect(() => {
    if (session.repo) return;
    const handed = takeFolder(session.id);
    if (!handed) return;
    queueMicrotask(() => void start(handed));
  }, [session.id, session.repo, start]);

  // Resume: a session that already owns a repo is read from the repo, not from
  // whatever happens to be on this machine.
  useEffect(() => {
    if (!session.repo) return;

    let cancelled = false;
    // Deferred a microtask so no state is set inside the effect body, matching
    // how the handed-off folder above is picked up.
    queueMicrotask(() => {
      if (cancelled) return;
      setScanning(true);
      scanSession(session)
        .then((scanned) => !cancelled && setResult(scanned))
        .catch((cause: unknown) => {
          if (cancelled) return;
          setError(cause instanceof Error ? cause.message : "Could not open this session.");
        })
        .finally(() => !cancelled && setScanning(false));
    });

    return () => {
      cancelled = true;
    };
  }, [session]);

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
    // Closing a tab discards its buffer, so anything still queued has to land
    // first or the edit is gone.
    void saver.flush();

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

  /**
   * Applies a change someone else committed.
   *
   * A clean buffer is replaced silently, which is the whole point. A dirty one
   * never is: overwriting unsaved work to show someone else's version would
   * lose the very thing the person is looking at. Those become a notice they
   * resolve by reopening the file.
   */
  const applyRemoteSave = useCallback(
    async (event: FileSavedEvent) => {
      setRepo((previous) => (previous ? { ...previous, headSha: event.headSha } : previous));

      const open = buffersRef.current.get(event.path);
      if (!open || open.loading) {
        // Not on screen. A new path means the tree is stale, so refresh it.
        if (!open) setTreeStale(true);
        return;
      }

      if (open.text !== open.original) {
        setConflicts((previous) => new Map(previous).set(event.path, event.authorName));
        return;
      }

      const content = await resultRef.current?.readFile(event.path);
      if (!content) return;

      setBuffers((previous) => {
        const buffer = previous.get(event.path);
        // Re-checked: the person may have started typing while this was in
        // flight, and their keystrokes outrank a background refresh.
        if (!buffer || buffer.text !== buffer.original) return previous;
        return new Map(previous).set(event.path, {
          ...buffer,
          original: content.text,
          text: content.text,
          size: content.size,
        });
      });
    },
    [],
  );

  function editBuffer(path: string, text: string) {
    setBuffers((previous) => {
      const buffer = previous.get(path);
      if (!buffer) return previous;
      return new Map(previous).set(path, { ...buffer, text });
    });

    setConflicts((previous) => {
      if (!previous.has(path)) return previous;
      const next = new Map(previous);
      next.delete(path);
      return next;
    });

    if (repo && !readOnly) {
      // Sent on the keystroke, not on the save: a save is over a second away,
      // which is far too late to show that someone is in the file.
      notifyEditing(session.id, path, caretRef.current.line, caretRef.current.column);
      setSaveState("saving");
      saver.queue(path, text);
    }
  }

  // Live updates from everyone else in this session.
  useEffect(() => {
    const stream = openSessionStream(session.id, {
      onFileSaved: (event) => {
        people.onSaved(event);
        void applyRemoteSave(event);
      },
      onFileEditing: people.onEditing,
      onMessage: (event) => setIncoming((previous) => [...previous, event.message]),
      onMembersChanged: people.refresh,
      onStatus: setLive,
    });
    return () => stream.close();
  }, [session.id, repo, applyRemoteSave, people]);

  // A broadcast named a file we have never seen, so the tree is out of date.
  useEffect(() => {
    if (!treeStale || !repo) return;
    let cancelled = false;
    queueMicrotask(() => {
      if (cancelled) return;
      scanSession({ ...session, repo })
        .then((scanned) => {
          if (cancelled) return;
          setResult(scanned);
          setTreeStale(false);
        })
        .catch(() => !cancelled && setTreeStale(false));
    });
    return () => {
      cancelled = true;
    };
  }, [treeStale, repo, session]);

  /** Throws away local edits in favour of the committed version, on request. */
  async function reloadFile(path: string) {
    const content = await result?.readFile(path);
    if (!content) return;

    setBuffers((previous) => {
      const buffer = previous.get(path);
      if (!buffer) return previous;
      return new Map(previous).set(path, {
        ...buffer,
        original: content.text,
        text: content.text,
        size: content.size,
      });
    });
    setConflicts((previous) => {
      const next = new Map(previous);
      next.delete(path);
      return next;
    });
  }

  async function toggleIgnored(next: boolean) {
    setIncludeIgnored(next);
    // Only meaningful before seeding. Afterwards the committed tree is the
    // truth and a local rescan would contradict it.
    if (picked && !repo) await scan(picked, next);
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
        canOpenFolder={!repo}
        members={people.members}
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
              <TeamChatPanel
                sessionId={session.id}
                members={people.members}
                incoming={incoming}
                onClose={() => setChatOpen(false)}
              />
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
                canRescan={!repo}
                onToggleIgnored={toggleIgnored}
                onOpenFile={openFile}
                onOpenFolder={openPicker}
                onClose={() => setExplorerOpen(false)}
                editing={people.editing}
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
            onCaretChange={trackCaret}
            readOnly={readOnly}
            conflictAuthor={activePath ? conflicts.get(activePath) : undefined}
            onReload={reloadFile}
            editing={people.editing}
            emptyState={
              <WelcomeView
                dragging={dragging}
                scanning={scanning}
                seeding={seeding}
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
        headSha={repo?.headSha ?? null}
        saveState={saveState}
        live={live}
      />

      {inviteOpen && <InviteDialog session={session} onClose={() => setInviteOpen(false)} />}
    </div>
  );
}
