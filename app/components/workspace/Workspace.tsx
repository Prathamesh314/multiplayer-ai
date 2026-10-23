"use client";

import { flattenPaths } from "../../lib/ai/file-mentions";
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
import { fetchMe } from "../../lib/auth/client";
import { readDroppedFolder, scanDirectoryHandle, scanFileList } from "../../lib/scan";
import { openSessionStream } from "../../lib/events/client";
import { loadSession, notifyEditing } from "../../lib/session/client";
import type { FileSavedEvent } from "../../lib/events/types";
import type { ChatMessage } from "../../lib/session/types";
import { startHeartbeat } from "../../lib/presence/client";
import { rememberOrg } from "../../lib/org/last-org";
import { takeFolder } from "../../lib/session/handoff";
import {
  addRepoFiles,
  createSaver,
  fetchRoomRepos,
  changeRoomRepoVisibility,
  deleteRoomRepo,
  importRoomRepo,
  scanSession,
  seedSession,
  type RoomRepo,
  type SeedProgress,
} from "../../lib/session/remote";
import { canEdit, type Session, type SessionRepo } from "../../lib/session/types";
import type { ScanResult } from "../../lib/types";
import { FilesIcon, SparkleIcon, TerminalIcon } from "../icons";
import type { AgentRun } from "../../lib/ai/runs";
import { fetchRun } from "../../lib/ai/runs-client";
import { isUUID } from "../../lib/tasks/types";
import { AiPanel } from "./AiPanel";
import type { Caret } from "./CodeEditor";
import type { Buffer } from "./EditorArea";
import { EditorArea } from "./EditorArea";
import { ExplorerPanel } from "./ExplorerPanel";
import { InviteDialog } from "./InviteDialog";
import { ShareChatDialog } from "./ShareChatDialog";
import { Resizer } from "./Resizer";
import { RowResizer } from "./RowResizer";
import { StatusBar } from "./StatusBar";
import { RoomSidebar } from "./RoomSidebar";
import { useRoomRuns } from "./useRoomRuns";
import { useRoomChanges } from "./useRoomChanges";
import { TerminalPanel } from "./TerminalPanel";
import { AddRepositoryDialog } from "./AddRepositoryDialog";
import { TopBar } from "./TopBar";
import { usePeople } from "./usePeople";
import { WelcomeView } from "./WelcomeView";
import { RoomGuide, type RoomGuideAction } from "./RoomGuide";
import { ConnectAiDialog } from "../ai/ConnectAiDialog";
import { DevicesDialog } from "../ai/DevicesDialog";
import { ComputerConnectionNotice } from "../ai/ComputerConnectionNotice";
import { useComputerConnection } from "../ai/useComputerConnection";
import { MemoryDialog } from "./MemoryDialog";

type SaveState = "idle" | "saving" | "saved" | "error";

// The File System Access API only exists on the client, so the value has to
// come through a store that reports `false` during server rendering.
const noopSubscribe = () => () => {};
const hasPicker = () => !!window.showDirectoryPicker;
const noPicker = () => false;

export function Workspace({
  session: initialSession,
  onAccessLost,
}: {
  session: Session;
  /** Called when a live role change revokes this account's access to the room. */
  onAccessLost?: (reason?: string) => void;
}) {
  const router = useRouter();
  const computerConnection = useComputerConnection();
  const navigatingRef = useRef(false);
  const [navigationPending, setNavigationPending] = useState(false);

  // The room's session held in state, not read straight from the prop, so a live
  // role change can refresh it in place — `readOnly` and every capability gate
  // below derive from `session.myRole`, so updating it re-locks or unlocks the UI
  // without a reload. If the parent hands us a genuinely different session object
  // (e.g. after unlocking), resync during render rather than in an effect.
  const [session, setSession] = useState(initialSession);
  const [syncedFrom, setSyncedFrom] = useState(initialSession);
  if (syncedFrom !== initialSession) {
    setSyncedFrom(initialSession);
    setSession(initialSession);
  }

  const inputRef = useRef<HTMLInputElement>(null);
  const supportsPicker = useSyncExternalStore(noopSubscribe, hasPicker, noPicker);
  const [actionsHost, setActionsHost] = useState<HTMLDivElement | null>(null);
  const [addRepositoryOpen, setAddRepositoryOpen] = useState(false);
  const [startEmptyProject, setStartEmptyProject] = useState(false);
  const [inviteOpen, setInviteOpen] = useState(false);
  const [memoryOpen, setMemoryOpen] = useState(false);

  const [picked, setPicked] = useState<PickedSource | null>(null);
  const [result, setResult] = useState<ScanResult | null>(null);
  // The repository's paths, for tagging with "@" in the AI chat.
  const mentionFiles = useMemo(() => (result ? flattenPaths(result.root) : []), [result]);
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
  // Bumped to force the live event stream to tear down and reopen now, rather
  // than waiting out EventSource's automatic retry (useful after a re-login).
  const [reconnectNonce, setReconnectNonce] = useState(0);
  /** Files a teammate changed under an edit of ours, which we refuse to discard. */
  const [conflicts, setConflicts] = useState<Map<string, string>>(() => new Map());
  const [treeRevision, setTreeRevision] = useState(0);
  const [treeError, setTreeError] = useState<string | null>(null);
  const refreshTree = useCallback(() => setTreeRevision(previous => previous + 1), []);

  // Enabled unconditionally: the roster and chat matter before a folder is up.
  const people = usePeople(session.id, true);
  const { onSaved: onPersonSaved, onEditing: onPersonEditing, refresh: refreshPeople } = people;
  /** Messages arriving over the stream, handed to the chat panel to merge. */

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

  const [teamChatWidth, setTeamChatWidth] = useState(260);
  const [showChat, setShowChat] = useState(true);
  const [rightWidth, setRightWidth] = useState(520);
  const [terminalOpen, setTerminalOpen] = useState(true);
  const [mobilePane, setMobilePane] = useState<"chat" | "files" | "team">("chat");
  const [showTeam, setShowTeam] = useState(true);
  const [helpDialog, setHelpDialog] = useState<"guide" | "providers" | "devices" | null>(null);
  const [terminalHeight, setTerminalHeight] = useState(360);
  // Live team-chat messages arriving over the session event stream.
  const [incoming, setIncoming] = useState<ChatMessage[]>([]);
  // The room's agent runs, and which one is open in the chat (null = new run).
  const { runs, refresh: refreshRuns } = useRoomRuns(session.id);
  const [enteredRun, setEnteredRun] = useState<AgentRun | null>(null);
  const [handoffInbox, setHandoffInbox] = useState<{ id: string; runId: string; title: string | null; sender: string }[]>([]);
  useEffect(() => {
    const controller = new AbortController();
    let expiry: ReturnType<typeof setTimeout> | undefined;
    const refresh = () => void fetch(`/api/sessions/${session.id}/handoffs`, { cache: "no-store", signal: controller.signal })
      .then(async response => {
        if (!response.ok) return;
        const body = await response.json();
        if (!controller.signal.aborted) {
          setHandoffInbox(body.offers);
          clearTimeout(expiry);
          const deadlines = body.offers.map((offer: { expiresAt: string }) => new Date(offer.expiresAt).getTime()).filter(Number.isFinite);
          if (deadlines.length) expiry = setTimeout(refresh, Math.max(0, Math.min(...deadlines) - Date.now() + 100));
        }
      }).catch(() => {});
    refresh();
    const stream = openSessionStream(session.id, { onRunControl: refresh, onRoleChanged: refresh, onStatus: connected => { if (connected) refresh(); } });
    return () => { controller.abort(); clearTimeout(expiry); stream.close(); };
  }, [session.id]);
  // The chat whose context the next new run will import into its memory, if any.
  // Shared so the sidebar/header "Fork" actions and the composer picker agree.
  const [forkFromRunId, setForkFromRunId] = useState<string | null>(null);

  // Additional repos imported into this room, and which one the next new chat
  // targets (null = the room's own project fork). A room is not bound to its
  // project's codebase: any folder can be imported and chatted about here.
  const [roomRepos, setRoomRepos] = useState<RoomRepo[]>([]);
  const [chatRepoId, setChatRepoId] = useState<string | null>(null);
  const activeRepository = chatRepoId ? roomRepos.find(item => item.id === chatRepoId) : repo;
  const hasRepo = !!activeRepository && activeRepository.seededAt !== null;
  const roomChanges = useRoomChanges(hasRepo ? session.id : undefined, chatRepoId, result?.git.commit);
  // Tabs showing their diff instead of their code, per repository ("repo\0path").
  const [diffTabs, setDiffTabs] = useState<Set<string>>(() => new Set());
  const diffKey = (path: string) => `${chatRepoId ?? ""}\0${path}`;
  const showDiff = (path: string, diff: boolean) => setDiffTabs(previous => {
    const next = new Set(previous);
    if (diff) next.add(diffKey(path)); else next.delete(diffKey(path));
    return next;
  });
  const selectedProjectRepositoryId = activeRepository?.projectRepositoryId ?? null;
  const selectedRepoRef = useRef<string | null>(null);
  const loadGeneration = useRef(0);
  const snapshots = useRef(new Map<string, { tabs: string[]; activePath: string | null; buffers: Map<string, Buffer> }>());
  const [importProgress, setImportProgress] = useState<SeedProgress | null>(null);
  const [importingRepo, setImportingRepo] = useState(false);
  /** Set when an import ends badly, so a held prompt is returned rather than run. */
  const [importFailed, setImportFailed] = useState(false);
  function openAddRepository(empty = false) {
    setStartEmptyProject(empty);
    setAddRepositoryOpen(true);
  }
  const importInputRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    let cancelled = false;
    void fetchRoomRepos(session.id).then(async (repos) => {
      if (cancelled) return;
      setRoomRepos(repos);
      let remembered: string | null = null;
      try { remembered = sessionStorage.getItem(`room-repository:${session.id}`); } catch {}
      const params = new URLSearchParams(window.location.search);
      const linkedRun = params.get("run");
      // Arrived to fork a chat from another room of the project (startFork there).
      const forkFrom = params.get("fork");
      if (forkFrom && isUUID(forkFrom)) {
        remembered = params.get("repo") || null;
        setForkFromRunId(forkFrom);
        setShowChat(true);
        setMobilePane("chat");
        window.history.replaceState(null, "", window.location.pathname);
      }
      if (linkedRun) {
        try {
          if (!isUUID(linkedRun)) throw new Error("Invalid chat link.");
          const { run } = await fetchRun(session.id, linkedRun);
          if (cancelled) return;
          remembered = run.repoId;
          setEnteredRun(run);
          setShowChat(true);
          setMobilePane("chat");
        } catch {
          if (!cancelled) setError("The linked chat is unavailable or you no longer have access.");
        }
      }
      if (cancelled) return;
      if (!remembered && !session.repo) remembered = repos.find(item => item.seededAt)?.id ?? null;
      if (remembered && repos.some(repo => repo.id === remembered && repo.seededAt) && buffersRef.current.size === 0) {
        selectedRepoRef.current = remembered;
        loadGeneration.current += 1;
        setChatRepoId(remembered);
        setResult(null);
      }
    }).catch(cause => { if (!cancelled) setError(cause instanceof Error ? cause.message : "Could not load imported repositories."); });
    return () => {
      cancelled = true;
    };
  }, [session.id, session.repo]);

  async function openImportPicker() {
    if (!window.showDirectoryPicker) {
      importInputRef.current?.click();
      return;
    }
    try {
      const handle = await window.showDirectoryPicker({ mode: "read" });
      await importRepoFromSource({ kind: "handle", handle, origin: "picker" });
    } catch (cause) {
      if (cause instanceof DOMException && cause.name === "AbortError") return;
      setError(cause instanceof Error ? cause.message : "Could not open that folder.");
    }
  }

  // The signed-in user's id, resolved directly rather than inferred from the
  // roster: a public room is entered by project role, so the viewer may have no
  // session_members row to carry an `isSelf` flag. This is what marks "you".
  const [myUserId, setMyUserId] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    void fetchMe().then((r) => {
      if (!cancelled) setMyUserId(r.user?.id ?? null);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  // Open a fresh chat with nothing carried over. The repo selection is kept —
  // staying in the codebase you were just working in is the common case.
  const startNewRun = () => {
    setShowChat(true);
    setMobilePane("chat");
    setEnteredRun(null);
    setForkFromRunId(null);
  };

  // What the composer's repo picker and the sidebar's grouping both read:
  // the room's own repo first (the project fork, or the seeded folder for a
  // personal room), then every finished import.
  const repoOptions = useMemo(() => {
    const defaultLabel = repo?.rootName ?? session.name;
    return [
      ...(repo ? [{ id: "", label: defaultLabel }] : []),
      ...roomRepos
        .filter((imported) => imported.seededAt)
        .map((imported) => ({
          id: imported.id, label: imported.rootName, private: imported.visibility === "private",
          // Who sees it is its creator's choice; deleting is theirs, or the room owner's while it is visible.
          canChangeVisibility: !readOnly && imported.createdBy === myUserId,
          canDelete: !readOnly && (imported.createdBy === myUserId || (session.myRole === "owner" && imported.visibility !== "private")),
        })),
    ];
  }, [session.name, session.myRole, repo, roomRepos, readOnly, myUserId]);
  // Another member added, removed, hid or showed a repository: reload, and leave one that is gone.
  const [reposVersion, setReposVersion] = useState(0);
  useEffect(() => {
    if (!reposVersion) return;
    void fetchRoomRepos(session.id).then((list) => {
      setRoomRepos(list);
      if (selectedRepoRef.current && !list.some((item) => item.id === selectedRepoRef.current)) {
        setEnteredRun(null);
        void selectRepository(null);
      }
    }).catch(() => {});
    refreshRuns();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reposVersion]);
  async function changeRepoVisibility(id: string, makePrivate: boolean) {
    await changeRoomRepoVisibility(session.id, id, makePrivate ? "private" : "room");
    setRoomRepos(await fetchRoomRepos(session.id));
  }
  async function removeRepository(id: string) {
    if (selectedRepoRef.current === id && !await selectRepository(null)) throw new Error("Save or resolve your edits before deleting this repository.");
    if (enteredRun?.repoId === id) setEnteredRun(null);
    await deleteRoomRepo(session.id, id);
    setRoomRepos(await fetchRoomRepos(session.id));
    refreshRuns();
  }
  // Fork a chat: a fresh chat that imports the source run's context on send.
  const startFork = async (run: AgentRun) => {
    // Someone else's room: the fork starts in your own room of the project.
    if (session.projectId && session.ownerId !== myUserId) {
      try {
        const response = await fetch(`/api/sessions/${encodeURIComponent(session.id)}/runs/${encodeURIComponent(run.id)}/fork-target`, { method: "POST" });
        const target = await response.json().catch(() => null) as { sessionId?: string; repoId?: string | null; error?: string } | null;
        if (!response.ok || !target?.sessionId) throw new Error(target?.error ?? "Could not open your room to fork this chat.");
        if (target.sessionId !== session.id) {
          router.push(`/s/${encodeURIComponent(target.sessionId)}?fork=${encodeURIComponent(run.id)}${target.repoId ? `&repo=${encodeURIComponent(target.repoId)}` : ""}`);
          return;
        }
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : "Could not open your room to fork this chat.");
        return;
      }
    }
    void selectRepository(run.repoId).then(selected => {
      if (!selected) return;
      setEnteredRun(null);
      setForkFromRunId(run.id);
      setShowChat(true);
      setMobilePane("chat");
    });
  };

  /**
   * Typing has no turn boundary to commit on, so it gets a debounced one. This
   * is what keeps "a session never holds uncommitted state" true for people as
   * well as for agents.
   */
  const savedFile = useCallback((path: string, saved: string, headSha: string) => {
          if (selectedRepoRef.current !== chatRepoId) return;
          if (chatRepoId) setRoomRepos(previous => previous.map(imported => imported.id === chatRepoId ? { ...imported, headSha } : imported));
          else setRepo((previous) => (previous ? { ...previous, headSha } : previous));
          const savedBuffer = buffersRef.current.get(path);
          if (savedBuffer?.text === saved) buffersRef.current = new Map(buffersRef.current).set(path, { ...savedBuffer, original: saved });
          setSaveState("saved");
          setBuffers((previous) => {
            const buffer = previous.get(path);
            if (!buffer) return previous;
            // Only clear the dirty marker if the buffer has not moved on since
            // this save was sent; another save is already queued if it has.
            if (buffer.text !== saved) return previous;
            return new Map(previous).set(path, { ...buffer, original: saved });
          });
        }, [chatRepoId]);
  const saver = useMemo(
    () => createSaver(session.id, savedFile,
      message => { setSaveState("error"); setError(message); },
      path => { setSaveState("error"); setConflicts(previous => new Map(previous).set(path, "a teammate")); },
      chatRepoId),
    [session.id, chatRepoId, savedFile],
  );

  async function navigatePage(destination: "back" | "forward" | "projects") {
    if (navigatingRef.current) return;
    navigatingRef.current = true;
    setNavigationPending(true);
    try {
      const saved = await saver.flush();
      if (!saved || [...buffersRef.current.values()].some(buffer => buffer.text !== buffer.original)) {
        setError("Your edits are not saved yet. Resolve them before leaving.");
        return;
      }
      if (destination === "projects") router.push("/workspace");
      else if (destination === "back") router.back();
      else router.forward();
    } catch {
      setError("Could not leave this page. Your edits are still here. Please try again.");
    } finally {
      navigatingRef.current = false;
      setNavigationPending(false);
    }
  }

  const selectRepository = useCallback(async (next: string | null): Promise<boolean> => {
    if (next === selectedRepoRef.current) return true;
    const generation = loadGeneration.current;
    if (!await saver.flush() || [...buffersRef.current.values()].some(buffer => buffer.text !== buffer.original)) {
      setError("Save or resolve your edits before switching repositories. Your text is still here.");
      return false;
    }
    if (generation !== loadGeneration.current) return false;
    snapshots.current.set(chatRepoId ?? "", { tabs, activePath, buffers: buffersRef.current });
    loadGeneration.current += 1;
    selectedRepoRef.current = next;
    const cached = snapshots.current.get(next ?? "");
    const restored = new Map([...(cached?.buffers ?? [])].filter(([, buffer]) => !buffer.loading));
    setBuffers(restored);
    buffersRef.current = restored;
    setTabs(cached?.tabs.filter(path => restored.has(path)) ?? []);
    setActivePath(cached?.activePath && restored.has(cached.activePath) ? cached.activePath : null);
    setConflicts(new Map());
    setResult(null);
    setTreeError(null);
    resultRef.current = null;
    setChatRepoId(next);
    setShowChat(true);
    setSaveState("idle");
    setError(null);
    try { sessionStorage.setItem(`room-repository:${session.id}`, next ?? ""); } catch {}
    return true;
  }, [saver, chatRepoId, tabs, activePath, session.id]);

  const importRepoFromSource = useCallback(async (source: PickedSource) => {
      setImportingRepo(true);
      setImportFailed(false);
      setError(null);
      try {
        const scanned =
          source.kind === "handle"
            ? await scanDirectoryHandle(source.handle, "picker", { includeIgnored: false })
            : await scanFileList(source.files, "input", { includeIgnored: false });
        // Show the folder the moment it is read, rather than after the upload.
        // The scan is already the real tree — the same one the explorer draws
        // from while a session's own folder uploads — so this is the files
        // actually being imported, not a placeholder. The repo-backed tree
        // replaces it below once the import commits.
        setResult(scanned);
        setMobilePane("files");
        const { repo: imported, skipped } = await importRoomRepo(session.id, scanned, setImportProgress);
        setRoomRepos((previous) => [...previous.filter(repo => repo.id !== imported.id), imported]);
        // The next new chat targets what was just imported — that's why it was.
        const selected = await selectRepository(imported.id);
        if (!selected) return;
        setMobilePane("files");
        setShowChat(true);
        setEnteredRun(null);
        if (skipped.length > 0) {
          setError(`${skipped.length} file(s) were too large or unusable and were left out of the import.`);
        }
      } catch (cause) {
        setImportFailed(true);
        setError(cause instanceof Error ? cause.message : "Could not import that folder.");
      } finally {
        setImportingRepo(false);
        setImportProgress(null);
      }
  }, [session.id, selectRepository]);

  async function enterRun(target: AgentRun) {
    if (await selectRepository(target.repoId)) {
      setEnteredRun(target);
      setShowChat(true);
      setMobilePane("chat");
    }
  }

  // Nothing in flight may be dropped on the way out.
  useEffect(() => {
    const onHide = () => void saver.flush();
    const beforeUnload = (event: BeforeUnloadEvent) => {
      if ([...buffersRef.current.values()].some(buffer => buffer.text !== buffer.original)) { event.preventDefault(); event.returnValue = ""; }
    };
    window.addEventListener("beforeunload", beforeUnload);
    window.addEventListener("pagehide", onHide);
    return () => {
      window.removeEventListener("pagehide", onHide);
      window.removeEventListener("beforeunload", beforeUnload);
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
      if (hasRepo && !readOnly && activePath) {
        notifyEditing(session.id, activePath, next.line, next.column, chatRepoId);
      }
    },
    [hasRepo, readOnly, activePath, session.id, chatRepoId],
  );

  // "Back to projects" (and a later visit) reopens this room's organisation.
  useEffect(() => { if (session.orgId) rememberOrg({ id: session.orgId }); }, [session.orgId]);

  // One heartbeat per open tab, for as long as this session is open. The tab
  // being open is what "online" means, so it starts and stops with the mount.
  // It also says which chat is open, so everyone on the same chat sees each
  // other (like collaborators at the top of a shared document).
  const heartbeat = useRef<ReturnType<typeof startHeartbeat> | null>(null);
  const [chatViewers, setChatViewers] = useState<{ runId: string | null; ids: string[] }>({ runId: null, ids: [] });
  const enteredRunId = enteredRun?.id ?? null;
  const enteredRunRef = useRef(enteredRunId);
  useEffect(() => { enteredRunRef.current = enteredRunId; }, [enteredRunId]);
  useEffect(() => {
    const beat = startHeartbeat({
      sessionId: session.id, orgId: session.orgId, runId: enteredRunRef.current, onOnline: people.onOnline,
      onViewers: ids => setChatViewers({ runId: enteredRunRef.current, ids }),
    });
    heartbeat.current = beat;
    // Someone opened, switched or closed a chat here: look again now, not at the next beat.
    let timer: ReturnType<typeof setTimeout> | undefined;
    const stream = openSessionStream(session.id, { onPresenceChanged: () => { clearTimeout(timer); timer = setTimeout(() => beat.beatNow(), 250); } });
    return () => { clearTimeout(timer); stream.close(); beat.stop(); heartbeat.current = null; };
  }, [session.id, session.orgId, people.onOnline]);
  useEffect(() => { heartbeat.current?.setRun(enteredRunId); }, [enteredRunId]);
  // People with this chat open, newest roster first; only for the chat in view.
  const viewers = chatViewers.runId === enteredRunId && enteredRunId
    ? people.members.filter(member => chatViewers.ids.includes(member.userId))
    : [];

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
      if (session.projectId) { await importRepoFromSource(source); return; }
      setPicked(source);
      // A new folder invalidates every open buffer.
      setTabs([]);
      setActivePath(null);
      setBuffers(new Map());
      const scanned = await scan(source, includeIgnored);
      if (scanned) await publish(scanned);
    },
    [includeIgnored, publish, scan, session.projectId, importRepoFromSource],
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
  const refreshOpenBuffers = useCallback(async (scanned: ScanResult, generation: number) => {
    for (const path of buffersRef.current.keys()) {
      const content = await scanned.readFile(path).catch(() => null);
      if (generation !== loadGeneration.current) return;
      const existing = buffersRef.current.get(path);
      if (existing && existing.text !== existing.original) {
        if (content?.text !== existing.original) setConflicts(previous => new Map(previous).set(path, "a repository update"));
        continue;
      }
      setBuffers(previous => {
        const buffer = previous.get(path);
        if (!buffer || buffer.loading || buffer.text !== buffer.original) return previous;
        return new Map(previous).set(path, content ? {
          ...buffer, ...content, original: content.text, error: undefined,
        } : { ...buffer, error: "This file is no longer available in the repository." });
      });
    }
  }, []);

  useEffect(() => {
    if (!hasRepo) return;

    let cancelled = false;
    const generation = loadGeneration.current;
    // Deferred a microtask so no state is set inside the effect body, matching
    // how the handed-off folder above is picked up.
    queueMicrotask(() => {
      if (cancelled) return;
      setScanning(true);
      setTreeError(null);
      scanSession({ ...session, repo }, chatRepoId)
        .then((scanned) => {
          if (cancelled || generation !== loadGeneration.current) return;
          setResult(scanned);
          void refreshOpenBuffers(scanned, generation);
        })
        .catch((cause: unknown) => {
          if (cancelled) return;
          setTreeError(cause instanceof Error ? cause.message : "Could not load repository files.");
        })
        .finally(() => !cancelled && setScanning(false));
    });

    return () => {
      cancelled = true;
    };
  }, [session, repo, hasRepo, chatRepoId, treeRevision, refreshOpenBuffers]);

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
    const generation = loadGeneration.current;
    setMobilePane("chat");
    setActivePath(path);
    setShowChat(false);
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

    let fileError: string | undefined;
    const content = await result?.readFile(path).catch(cause => {
      fileError = cause instanceof Error ? cause.message : "Could not open this file. Try again.";
      return null;
    });
    if (generation !== loadGeneration.current) return;
    setBuffers((previous) =>
      new Map(previous).set(path, {
        original: content?.text ?? "",
        text: content?.text ?? "",
        size: content?.size ?? 0,
        binary: content?.binary ?? false,
        truncated: content?.truncated ?? false,
        loading: false,
        error: content ? undefined : fileError ?? "This file is no longer available. Refresh the explorer.",
      }),
    );
  }

  /** From the Changes tab: the file's diff in the editor area, beside the chat. */
  function openDiff(path: string) {
    showDiff(path, true);
    void openFile(path);
  }

  /** From the file tree: the file's code, even if its tab was showing changes. */
  function openCode(path: string) {
    showDiff(path, false);
    void openFile(path);
  }

  async function closeTab(path: string) {
    const generation = loadGeneration.current;
    // Closing a tab discards its buffer, so anything still queued has to land
    // first or the edit is gone.
    if (!await saver.flush() || generation !== loadGeneration.current) return;
    const latest = buffersRef.current.get(path);
    if (latest && latest.text !== latest.original) { setError("This file still has unsaved changes. Resolve them before closing."); return; }

    setTabs((previous) => {
      const next = previous.filter((candidate) => candidate !== path);
      if (path === activePath) {
        setActivePath(next.at(-1) ?? null);
        // Closing the last file returns the right-top to the Files tree.
        if (next.length === 0) setShowChat(true);
      }
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
    async function applyRemoteSave(event: FileSavedEvent) {
      if ((event.repoId ?? null) !== selectedRepoRef.current) return;
      const generation = loadGeneration.current;
      if (event.repoId) setRoomRepos(previous => previous.map(imported => imported.id === event.repoId ? { ...imported, headSha: event.headSha } : imported));
      else setRepo((previous) => (previous ? { ...previous, headSha: event.headSha } : previous));
      if (!event.path) {
        refreshTree();
        for (const path of buffersRef.current.keys()) await applyRemoteSave({ ...event, path });
        return;
      }

      const open = buffersRef.current.get(event.path);
      if (!open || open.loading) {
        // Not on screen. A new path means the tree is stale, so refresh it.
        if (!open) refreshTree();
        return;
      }

      if (open.text !== open.original) {
        setConflicts((previous) => new Map(previous).set(event.path, event.authorName));
        return;
      }

      const content = await resultRef.current?.readFile(event.path).catch(() => null);
      if (!content || generation !== loadGeneration.current) return;

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
    [refreshTree],
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

    if (hasRepo && !readOnly) {
      // Sent on the keystroke, not on the save: a save is over a second away,
      // which is far too late to show that someone is in the file.
      notifyEditing(session.id, path, caretRef.current.line, caretRef.current.column, chatRepoId);
      setSaveState("saving");
      // The buffer's `original` is the committed version this edit is based on;
      // the server merges against it so a concurrent change is never clobbered.
      saver.queue(path, text, buffersRef.current.get(path)?.original ?? "");
    }
  }

  // Live updates from everyone else in this session.
  useEffect(() => {
    const stream = openSessionStream(session.id, {
      onFileSaved: (event) => {
        if ((event.repoId ?? null) !== selectedRepoRef.current) return;
        onPersonSaved(event);
        void applyRemoteSave(event);
      },
      onFileEditing: event => { if ((event.repoId ?? null) === selectedRepoRef.current) onPersonEditing(event); },
      onMessage: (event) => setIncoming((previous) => [...previous, event.message]),
      onMembersChanged: refreshPeople,
      onReposChanged: () => setReposVersion((value) => value + 1),
      onRoleChanged: (event) => {
        // Only the named user reacts, and they re-read their own role through the
        // authorised route rather than trusting anything pushed over the wire.
        if (!myUserId || event.userId !== myUserId) return;
        void loadSession(session.id)
          .then((loaded) => {
            if (loaded.state === "ready") setSession(loaded.session);
            else onAccessLost?.(loaded.state === "locked" ? loaded.reason : undefined);
          })
          .catch(() => {
            // A transient failure shouldn't nuke the room; keep the current role.
          });
      },
      onStatus: connected => {
        setLive(connected);
        if (connected) {
          refreshTree();
          void fetchRoomRepos(session.id).then(setRoomRepos).catch(() => {});
        }
      },
    });
    return () => stream.close();
  }, [session.id, applyRemoteSave, onPersonSaved, onPersonEditing, refreshPeople, refreshTree, reconnectNonce, myUserId, onAccessLost]);

  /** Throws away local edits in favour of the committed version, on request. */
  async function reloadFile(path: string) {
    const generation = loadGeneration.current;
    let fileError: string | undefined;
    const content = await result?.readFile(path).catch(cause => {
      fileError = cause instanceof Error ? cause.message : "Could not reload this file.";
      return null;
    });
    if (generation !== loadGeneration.current) return;
    if (!content) {
      setError(fileError ?? "The file is unavailable. Your buffer was preserved.");
      return;
    }

    setBuffers((previous) => {
      const buffer = previous.get(path);
      if (!buffer) return previous;
      return new Map(previous).set(path, {
        ...buffer,
        ...content,
        original: content.text,
        loading: false,
        error: undefined,
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

  function navigateGuide(action: RoomGuideAction) {
    setHelpDialog(null);
    if (action === "providers" || action === "devices") setHelpDialog(action);
    else if (action === "memory") setMemoryOpen(true);
    else if (action === "invite") setInviteOpen(true);
    else if (action === "files") {
      if (!hasRepo && !readOnly) openAddRepository();
      else setMobilePane("files");
    } else if (action === "team") {
      setShowTeam(true);
      setMobilePane("team");
    } else {
      setShowChat(true);
      setActivePath(null);
      setMobilePane("chat");
    }
  }

  return (
    <div
      className="session-workspace flex h-dvh flex-col overflow-hidden bg-vs-editor text-vs-fg"
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
        onOpenGuide={() => setHelpDialog("guide")}
        session={session}
        inviteLabel={enteredRun ? "Share chat" : "Invite"}
        onInvite={() => setInviteOpen(true)}
        onLeave={() => { void navigatePage("projects"); }}
        onNavigate={direction => { void navigatePage(direction); }}
        navigationPending={navigationPending}
        folderName={result?.rootName ?? null}
        branch={result?.git.branch ?? null}
        isGit={!!result?.git.isGit}
        terminalOpen={terminalOpen}
        onToggleTerminal={() => setTerminalOpen(!terminalOpen)}
        onOpenFolder={openPicker}
        canOpenFolder={!hasRepo && !readOnly}
        members={people.members}
        repoId={chatRepoId}
        hasRepository={hasRepo}
        sharedRepository={!!selectedProjectRepositoryId}
        beforePublish={async () => await saver.flush() && ![...buffersRef.current.values()].some(buffer => buffer.text !== buffer.original)}
        onPublished={async () => {
          const [fresh, repos] = await Promise.all([loadSession(session.id), fetchRoomRepos(session.id)]);
          if (fresh.state === "ready") setRepo(fresh.session.repo);
          setRoomRepos(repos); setTreeRevision(value => value + 1);
        }}
      />
      <ComputerConnectionNotice compact connection={computerConnection} onConnect={() => setHelpDialog("devices")} onSetUpAi={() => setHelpDialog("providers")} />
      {helpDialog === "guide" && <RoomGuide hasRepo={hasRepo} readOnly={readOnly} onClose={() => setHelpDialog(null)} onAction={navigateGuide} />}
      {helpDialog === "providers" && <ConnectAiDialog onClose={() => setHelpDialog(null)} onOpenDevices={() => setHelpDialog("devices")} />}
      {helpDialog === "devices" && <DevicesDialog onClose={() => setHelpDialog(null)} onSetUpAi={() => setHelpDialog("providers")} />}
      {memoryOpen && <MemoryDialog key={session.id} roomId={session.id} readOnly={readOnly} onClose={() => setMemoryOpen(false)} onOpenRun={runId => {
        void fetchRun(session.id,runId).then(({run}) => {enterRun(run);setMemoryOpen(false);}).catch(() => setError("Could not open the source chat."));
      }} />}
      {addRepositoryOpen && !readOnly && <AddRepositoryDialog sessionId={session.id}
        sharedProject={!!session.projectId} startEmpty={startEmptyProject}
        selected={[...roomRepos.map(item => item.projectRepositoryId), repo?.projectRepositoryId].filter((id): id is string => !!id)}
        onClose={() => setAddRepositoryOpen(false)}
        onImport={() => { setAddRepositoryOpen(false); void openImportPicker(); }}
        onAdded={async (added, empty) => {
          setRoomRepos(previous => [...previous.filter(item => item.id !== added.id), added]);
          if (!await selectRepository(added.id)) throw new Error("Repository added. Close this dialog and save your edits before opening it from the sidebar.");
          setEnteredRun(null); setForkFromRunId(null); setShowChat(true);
          setMobilePane(empty ? "chat" : "files"); setAddRepositoryOpen(false);
        }} />}
      {error && hasRepo && <div role="alert" className="flex shrink-0 items-start gap-3 border-b border-vs-danger/25 bg-vs-danger/10 px-4 py-2 text-sm text-vs-danger"><span className="min-w-0 flex-1 break-words">{error}</span><button className="shrink-0 underline" onClick={() => setError(null)}>Dismiss</button></div>}
      {handoffInbox.filter(offer => offer.runId !== enteredRun?.id).map(offer => <div key={offer.id} role="status" className="flex shrink-0 items-center gap-3 border-b border-vs-accent/25 bg-vs-accent/10 px-4 py-2 text-xs">
        <span className="min-w-0 flex-1 truncate"><strong>{offer.sender}</strong> offered you a handoff · {offer.title ?? "AI chat"}</span>
        <button className="shrink-0 rounded-lg border border-vs-accent/40 px-3 py-1 font-medium text-vs-accent" onClick={() => { void fetchRun(session.id, offer.runId).then(({ run }) => enterRun(run)).catch(() => setError("Could not open this handoff. Refresh the room and try again.")); }}>Open handoff</button>
      </div>)}

      <input
        ref={inputRef}
        type="file"
        aria-label="Upload initial folder"
        multiple
        webkitdirectory=""
        directory=""
        onChange={onInputChange}
        className="hidden"
      />
      {/* Fallback folder picker for importing an additional repo into the room. */}
      <input
        ref={importInputRef}
        type="file"
        aria-label="Import repository folder"
        multiple
        webkitdirectory=""
        directory=""
        onChange={(event) => {
          const files = [...(event.target.files ?? [])];
          event.target.value = "";
          if (files.length > 0) {
            void importRepoFromSource({ kind: "files", files, origin: "input" });
          }
        }}
        className="hidden"
      />

      <div className="session-panels vs-scroll flex min-h-0 flex-1 overflow-x-auto">
            {/* Repositories and their associated AI chats. */}
            <div
              style={{ width: teamChatWidth }}
              className={`room-sidebar min-h-0 shrink-0 flex-col border-r border-vs-border ${mobilePane === "team" ? "flex" : "hidden"} ${showTeam ? "lg:flex" : "lg:hidden"}`}
            >
              <RoomSidebar
                sessionId={session.id}
                roomName={session.name}
                members={people.members}
                myUserId={myUserId}
                incoming={incoming}
                runs={runs}
                repos={repoOptions}
                enteredRunId={enteredRun?.id ?? null}
                onEnter={target => void enterRun(target)}
                onNewRun={next => { void selectRepository(next).then(selected => { if (selected) startNewRun(); }); }}
                onAddRepository={() => openAddRepository()}
                importing={importingRepo}
                canAdd={!readOnly}
                onFork={startFork}
                onRenamed={refreshRuns}
                onRepoVisibility={changeRepoVisibility}
                onDeleteRepo={removeRepository}
              />
            </div>
            {showTeam && <div className="hidden lg:flex"><Resizer width={teamChatWidth} onResize={setTeamChatWidth} min={220} max={320} /></div>}

        {!hasRepo ? (
          // Start without files or import a repository before opening the workspace.
          <div className="flex min-h-0 flex-1 flex-col bg-vs-editor">
            <WelcomeView
              readOnly={readOnly}
              dragging={dragging}
              scanning={scanning || importingRepo}
              seeding={seeding ?? importProgress}
              progress={progress}
              supportsPicker={supportsPicker}
              error={error}
              hasFolder={!!result}
              hasRepo={hasRepo}
              onOpenPicker={openPicker}
              onOpenInput={() => inputRef.current?.click()}
              onStartEmpty={() => openAddRepository(true)}
            />
          </div>
        ) : (
          <>
            <div className={`room-main min-h-0 min-w-0 flex-1 flex-col ${mobilePane === "chat" ? "flex" : "hidden"} lg:flex`}>
              <EditorArea
                tabs={tabs}
                activePath={activePath}
                buffers={buffers}
                onSelectTab={(path) => {
                  setActivePath(path);
                  setShowChat(false);
                  setCaret({ line: 1, column: 1 });
                }}
                onCloseTab={closeTab}
                onChange={editBuffer}
                onCaretChange={trackCaret}
                readOnly={readOnly}
                conflictAuthor={activePath ? conflicts.get(activePath) : undefined}
                onReload={reloadFile}
                editing={people.editing}
                pinned={{
                  label: enteredRun?.title ?? "New chat",
                  icon: <SparkleIcon className="h-3.5 w-3.5" />,
                  node: (
                      <AiPanel
                        computerStatus={computerConnection.status}
                        onSetUpAi={() => setHelpDialog("providers")}
                        actionsHost={actionsHost}
                        onShowConversation={() => setShowChat(true)}
                        sessionId={session.id}
                        canRun={!readOnly}
                        members={people.members}
                        viewers={viewers}
                        myUserId={myUserId}
                        entered={enteredRun}
                        isOwner={session.myRole === "owner"}
                        onRunsChanged={refreshRuns}
                        onEntered={target => { if (target.repoId === selectedRepoRef.current) setEnteredRun(target); }}
                        forkFromRunId={forkFromRunId}
                        onForkFromChange={setForkFromRunId}
                        onForkEntered={startFork}
                        onNewRun={startNewRun}
                        repoOptions={repoOptions}
                        hasFiles={result ? result.stats.files > 0 : undefined}
                        files={mentionFiles}
                        repoId={chatRepoId}
                        onRepoChange={next => void selectRepository(next)}
                        onImportRepo={() => openAddRepository()}
                        importingRepo={importingRepo}
                        importFailed={importFailed}
                      />
                  ),
                }}
                pinnedActive={showChat}
                onSelectPinned={() => setShowChat(true)}
                changes={roomChanges}
                diffSource={hasRepo ? { sessionId: session.id, repoId: chatRepoId } : undefined}
                showsDiff={path => diffTabs.has(diffKey(path))}
                onShowDiff={showDiff}
                emptyState={
                  <div className="flex flex-1 items-center justify-center p-6 text-center text-sm text-vs-muted">
                    <div className="max-w-xs space-y-3">
                      <FilesIcon className="mx-auto h-7 w-7 text-vs-muted" />
                      <p className="font-medium text-vs-fg">{treeError ? "Could not load files" : scanning ? "Loading repository files…" : "Your repository files"}</p>
                      <p>{treeError ?? (result ? "Choose a file in the explorer to read or edit it. Your changes are saved automatically." : "The repository has not loaded yet.")}</p>
                      {!result && !scanning && <button type="button" onClick={refreshTree} className="rounded-lg border border-vs-border px-3 py-2 text-vs-fg hover:bg-vs-hover">Retry loading files</button>}
                    </div>
                  </div>
                }
              />
            </div>

            <div className="hidden lg:flex"><Resizer width={rightWidth} onResize={setRightWidth} min={280} max={600} invert /></div>

            <div
              style={{ width: rightWidth }}
              className={`room-explorer-panel min-h-0 min-w-0 shrink flex-col border-l border-vs-border ${mobilePane === "files" ? "flex" : "hidden"} lg:flex`}
            >
              <div className="flex min-h-0 flex-1 flex-col">
                {result ? (
                  <ExplorerPanel
                    actionsRef={setActionsHost}
                    key={`${chatRepoId ?? "default"}:${includeIgnored}`}
                    result={result}
                    activePath={activePath}
                    scanning={scanning || importingRepo}
                    error={treeError}
                    onRefresh={refreshTree}
                    onImport={!readOnly ? () => void openImportPicker() : undefined}
                    repositories={repoOptions.filter(option => option.id !== (chatRepoId ?? ""))}
                    onSelectRepository={next => { void selectRepository(next || null).then(changed => { if (changed) { startNewRun(); setMobilePane("files"); } }); }}
                    includeIgnored={includeIgnored}
                    canRescan={!hasRepo}
                    onToggleIgnored={toggleIgnored}
                    onOpenFile={openCode}
                    onOpenDiff={openDiff}
                    changes={roomChanges}
                    editing={people.editing}
                    sessionId={hasRepo ? session.id : undefined}
                    repoId={chatRepoId}
                    onAddFiles={hasRepo && !readOnly ? (files, overwrite) => addRepoFiles(session.id, chatRepoId, files, overwrite).then(added => { refreshTree(); return added; }) : undefined}
                  />
                ) : (
                    <div className="flex flex-1 items-center justify-center p-6 text-center text-sm text-vs-muted">
                      <div className="max-w-xs space-y-3">
                        <FilesIcon className="mx-auto h-7 w-7 text-vs-muted" />
                        <p className="font-medium text-vs-fg">{treeError ? "Could not load files" : scanning ? "Loading repository files…" : "Your repository files"}</p>
                        <p>{treeError ?? (result ? "Choose a file in the explorer to read or edit it. Your changes are saved automatically." : "The repository has not loaded yet.")}</p>
                        {!result && !scanning && <button type="button" onClick={refreshTree} className="rounded-lg border border-vs-border px-3 py-2 text-vs-fg hover:bg-vs-hover">Retry loading files</button>}
                      </div>
                    </div>
                )}
              </div>

              {terminalOpen ? (
                <>
                  <RowResizer height={terminalHeight} onResize={setTerminalHeight} min={140} max={600} />
                  <div style={{ height: terminalHeight, maxHeight: "60%" }} className="flex min-h-0 shrink-0">
                    <div className="flex min-h-0 w-full flex-col"><TerminalPanel onClose={() => setTerminalOpen(false)} context={{ sessionId: session.id, runId: enteredRun?.id ?? null, repoId: chatRepoId ?? null }} /></div>
                  </div>
                </>
              ) : (
                <button
                  type="button"
                  onClick={() => setTerminalOpen(true)}
                  className="flex shrink-0 items-center gap-2 border-t border-vs-border bg-vs-panel px-3 py-1.5 text-[12px] text-vs-muted transition hover:text-vs-fg"
                >
                  <TerminalIcon className="h-3.5 w-3.5" />
                  Terminal
                </button>
              )}
            </div>
          </>
        )}
      </div>

      <StatusBar
        result={result}
        activePath={activePath}
        activeText={activeBuffer && !activeBuffer.loading && !activeBuffer.binary ? activeBuffer.text : null}
        caret={caret}
        headSha={chatRepoId ? roomRepos.find(imported => imported.id === chatRepoId)?.headSha ?? null : repo?.headSha ?? null}
        saveState={saveState}
        live={live}
        onReconnect={() => {
          setLive(false);
          setReconnectNonce((n) => n + 1);
        }}
      />

      {inviteOpen && (enteredRun
        ? <ShareChatDialog key={enteredRun.id} run={enteredRun} onClose={() => setInviteOpen(false)} />
        : <InviteDialog session={session} onClose={() => setInviteOpen(false)} />)}
    </div>
  );
}
