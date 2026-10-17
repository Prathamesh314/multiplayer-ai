"use client";
import type { PermissionMode } from "../../lib/ai/runs";
import { readApprovalMode, rememberApprovalMode } from "../../lib/ai/approval-mode";
import type { MentionFile } from "../../lib/ai/file-mentions";
import { preferredAgent, rememberChoice, savedPicks } from "../../lib/ai/composer-choice";
import { openUserStream } from "../../lib/events/shared-client";

import { createPortal } from "react-dom";
import { Modal } from "../ui/Modal";
import { ComposerPicker, type ComposerOption } from "./ComposerPicker";
import { ModelPicker } from "./ModelPicker";

import { useCallback, useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { agentById, type AgentChoice, type AgentStatus } from "../../lib/ai/catalog";
import {
  fetchAgents,
  fetchForkableRuns,
  fetchMentionTargets,
  runAgent,
  type ForkableRun,
  type RunHandle,
} from "../../lib/ai/client";
import type { AgentRun } from "../../lib/ai/runs";
import { fetchRun } from "../../lib/ai/runs-client";
import type { MessageAttachment } from "../../lib/events/types";
import { attachmentUrl, formatBytes } from "../../lib/ai/attachments-client";
import { describeStep } from "../../lib/ai/steps";
import { openSessionStream } from "../../lib/events/client";
import { colorOf, initialsOf } from "../../lib/people";
import type { SessionMember } from "../../lib/session/types";
import {
  AlertIcon,
  CheckIcon,
  ChevronIcon,
  CloseIcon,
  EyeIcon,
  FilesIcon,
  GitBranchIcon,
  PlusIcon,
  SparkleIcon,
  SpinnerIcon,
  TerminalIcon,
  ShieldIcon,
} from "../icons";
import { QueuedMessages, WorkingStatus } from "./QueuedMessages";
import { PermissionRequests } from "./PermissionRequests";
import { Composer, type ComposerHandle, type MentionRoom, type MentionPerson } from "./chat";
import { WorkspaceHistory } from "./WorkspaceHistory";
import { HandoffPanel } from "./HandoffPanel";
import { ChatBranchPanel } from "./ChatBranchPanel";
import { useTitleTransition } from "./useTitleTransition";
import { TaskPanel } from "../tasks/TaskPanel";
import { BriefingCard } from "../collaboration/BriefingCard";
import { CollaborationControls } from "../collaboration/CollaborationControls";
import { isSelfAssignment, SELF_ASSIGNMENT_ERROR } from "../../lib/tasks/types";
import { Markdown } from "./Markdown";
import type { ComputerStatus } from "../ai/useComputerConnection";

type AiPanelProps = {
  computerStatus: ComputerStatus;
  /** False when the connected computer's runner is too old to ask before tools; the CLI refuses them then. */
  computerAsks?: boolean;
  onSetUpAi: () => void;
  actionsHost?: HTMLDivElement | null;
  onShowConversation?: () => void;
  sessionId: string;
  /** False for viewers: running an agent edits files. */
  canRun: boolean;
  isOwner?: boolean;
  /** Room roster, for the "watching" cluster in the header. */
  members: SessionMember[];
  /** The signed-in user's id — reliable even in a public room with no roster row. */
  myUserId: string | null;
  /** The run whose conversation is shown; null = composing a fresh one. */
  entered: AgentRun | null;
  /** Reload the room's runs after this tab starts one. */
  onRunsChanged: () => void;
  /**
   * A run this tab just started, so the parent can make it the entered run —
   * that is what keeps follow-up prompts in the same chat instead of opening a
   * new one each time.
   */
  onEntered?: (run: AgentRun) => void;
  /**
   * The chat whose context the next new run will import into its AI memory, or
   * null for none. Controlled by the parent so the sidebar/header "Fork"
   * actions and the composer's own picker all drive one selection.
   */
  forkFromRunId: string | null;
  onForkFromChange: (runId: string | null) => void;
  /** "Fork" a run in view: open a fresh chat that imports that run's context. */
  onForkEntered: (run: AgentRun) => void;
  /** Clear the entered run to compose a fresh one. */
  onNewRun: () => void;
  /**
   * The repos a new chat can work on: the room's own (id "") first, then each
   * imported one. Controlled by the parent, which also owns the import flow —
   * a continued chat keeps the repo it started on, so the picker only shows
   * while composing fresh.
   */
  repoOptions: { id: string; label: string }[];
  hasFiles?: boolean;
  /** The repository's files and folders, tagged in a message with "@". */
  files?: MentionFile[];
  repoId: string | null;
  onRepoChange: (repoId: string | null) => void;
  /** Start without files or import a folder into the workspace. */
  onImportRepo: () => void;
  importingRepo: boolean;
  /** True when the last import ended badly; a held prompt goes back to the composer. */
  importFailed?: boolean;
  /** Omitted when embedded as the center Chat tab, where there is no X to show. */
  onClose?: () => void;
};

/** One line of the conversation, whether streamed live or read from history. */
type Turn = {
  id: string;
  role: "user" | "agent" | "system";
  text: string;
  /** Files sent with a user message. */
  attachments?: MessageAttachment[];
  author?: string | null;
  agentName?: string | null;
  /** True while the agent is still writing into this turn. */
  streaming?: boolean;
  /** Live reasoning trace (Claude's thinking) — ephemeral, not stored. */
  thinking?: string;
  /** Tool steps as they happen, e.g. "Read app/x.ts" — ephemeral, not stored. */
  activities?: string[];
  /** Epoch ms this agent turn began, for the live elapsed timer. */
  startedAt?: number;
  /**
   * The run's stderr, live. Nothing the AI emits is hidden from the chat: the
   * log is always openable under the turn, and surfaces expanded when the run
   * fails — that's where the reason lives.
   */
  errText?: string;
  /** Set from the exit event when the run ended non-zero. */
  failed?: boolean;
  /** A live "waiting for your computer" line, removed once the agent starts. */
  waiting?: boolean;
};

export function AiPanel({
  computerStatus,
  computerAsks = true,
  onSetUpAi,
  actionsHost,
  onShowConversation,
  sessionId,
  canRun,
  isOwner = false,
  members,
  myUserId,
  entered,
  onRunsChanged,
  onEntered,
  forkFromRunId,
  onForkFromChange,
  onForkEntered,
  onNewRun,
  repoOptions,
  hasFiles = true,
  files,
  repoId,
  onRepoChange,
  onImportRepo,
  importingRepo,
  importFailed = false,
  onClose,
}: AiPanelProps) {
  const [assignOpen, setAssignOpen] = useState(false);
  /**
   * A prompt sent while a folder is still importing. Held here and replayed
   * when the import commits, rather than run against a half-written repo: the
   * agent would read an incomplete checkout and confidently edit the wrong
   * thing, which is worse than waiting.
   */
  const [heldPrompt, setHeldPrompt] = useState<{ prompt: string; contextRefs?: string[]; attachments?: MessageAttachment[]; fileRefs?: string[] } | null>(null);
  const [briefingOpen, setBriefingOpen] = useState(false);
  const [branchOpen, setBranchOpen] = useState(false);
  // Whether this server runs chats on their own branches, and whether the next
  // new chat should. Off by default: an ordinary chat works on the room branch.
  const [parallelChats, setParallelChats] = useState(false);
  const [parallel, setParallel] = useState(false);
  const [planMode, setPlanMode] = useState(false);
  const composer = useRef<ComposerHandle>(null);
  const [taskRevision, setTaskRevision] = useState(0);
  const [taskRoster, setTaskRoster] = useState<{ sessionId: string; people: MentionPerson[] } | null>(null);
  const taskRequest = useRef<{ payload: string; id: string } | null>(null);
  const [agents, setAgents] = useState<AgentStatus[] | null>(null);
  const [serverCanRun, setServerCanRun] = useState(false);
  const [agentsError, setAgentsError] = useState<string | null>(null);
  const [blockedReason, setBlockedReason] = useState<string | null>(null);
  const [connected, setConnected] = useState<string | null>(null);
  // Read by the agents refresh, which outlives renders.
  const connectedRef = useRef<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [installFor, setInstallFor] = useState<string | null>(null);
  // Composer selectors. Reset together with the provider, since the options do.
  const [model, setModel] = useState("");
  const [showProviders, setShowProviders] = useState(false);
  // Held in state, not a ref: the popover is positioned from this element
  // during render, so it has to be a value React re-renders on.
  const [providersButton, setProvidersButton] = useState<HTMLButtonElement | null>(null);
  const closeProviders = useCallback(() => setShowProviders(false), []);
  // A rename that arrived over the room stream, ahead of the parent's copy of
  // the run. Scoped to one run id so it cannot leak onto the next chat.
  const [renamedTitle, setRenamedTitle] = useState<{ runId: string; title: string } | null>(null);
  const [effort, setEffort] = useState("");
  // Candidate chats to import context from. The chosen one (forkFromRunId) is
  // controlled by the parent so a "Fork" action elsewhere preselects it here.
  const [forkableRuns, setForkableRuns] = useState<ForkableRun[]>([]);
  // Every room in the project (with its chats) for the composer's @ picker —
  // includes empty rooms, unlike forkableRuns.
  const [mentionTargets, setMentionTargets] = useState<MentionRoom[]>([]);

  useEffect(() => {
    const controller = new AbortController();
    let loading = false, dirty = false;
    const load = async () => {
      if (document.hidden || controller.signal.aborted) return;
      if (loading) { dirty = true; return; }
      dirty = false;
      loading = true;
      try {
        const response = await fetch(`/api/tasks?sessionId=${encodeURIComponent(sessionId)}`, { signal: controller.signal, cache: "no-store" });
        if (response.ok) {
          const data = await response.json();
          if (!controller.signal.aborted) setTaskRoster({ sessionId, people: data.members });
        } else if (!controller.signal.aborted) setTaskRoster({ sessionId, people: [] });
      } catch { /* A later refresh retries the room roster. */ }
      finally { loading = false; if (dirty && !controller.signal.aborted) void load(); }
    };
    const stream = openSessionStream(sessionId, { onMembersChanged: () => void load(), onRoleChanged: () => void load(), onStatus: connected => { if (connected) void load(); } });
    document.addEventListener("visibilitychange", load);
    return () => { controller.abort(); stream.close(); document.removeEventListener("visibilitychange", load); };
  }, [sessionId]);

  const [turns, setTurns] = useState<Turn[]>([]);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [historyFailed, setHistoryFailed] = useState(false);
  const run = useRef<RunHandle | null>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const turnSeq = useRef(0);
  const historyGeneration = useRef(0);
  const uid = () => `t${(turnSeq.current += 1)}`;

  // Reliable even in a public room (no roster row to carry isSelf); falls back
  // to the roster only until the id resolves. Drives continue-vs-fork and "you".
  const myId = myUserId ?? members.find((member) => member.isSelf)?.userId ?? null;
  // A slow or failed roster refresh must never offer people from the last room.
  // Also filter locally in case an older server response still includes self.
  const taskPeople = (taskRoster?.sessionId === sessionId ? taskRoster.people : [])
    .filter(person => myId && !isSelfAssignment(myId, person.userId));
  // Whether the run in view is the current user's (or a fresh compose).
  const enteredIsMine = !entered || entered.driverUserId === myId;
  // Approvals: Manual ("ask") waits for the driver to allow each command, web
  // link or connector; Auto allows them without asking. A new chat starts with
  // the member's last choice on this device; an existing one keeps its own.
  const [defaultMode, setDefaultMode] = useState<PermissionMode>(readApprovalMode);
  const [modeChanges, setModeChanges] = useState<Record<string, PermissionMode>>({});
  const approvalMode: PermissionMode = entered && enteredIsMine ? modeChanges[entered.id] ?? entered.permissionMode ?? "ask" : defaultMode;
  function changeApprovalMode(value: string) {
    const mode: PermissionMode = value === "auto" ? "auto" : "ask";
    setDefaultMode(mode);
    rememberApprovalMode(mode);
    if (!entered || !enteredIsMine) return;
    const runId = entered.id;
    setModeChanges((changes) => ({ ...changes, [runId]: mode }));
    void fetch(`/api/sessions/${encodeURIComponent(sessionId)}/runs/${encodeURIComponent(runId)}/permissions`, {
      method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ mode }),
    }).then(async (response) => {
      if (!response.ok) throw new Error((await response.json().catch(() => null))?.error ?? "Could not change approvals.");
    }).catch((cause) => {
      setModeChanges((changes) => { const next = { ...changes }; delete next[runId]; return next; });
      setError(cause instanceof Error ? cause.message : "Could not change approvals.");
    });
  }
  // In the composer for a new chat; in the chat's header once it exists, so it
  // stays reachable while the agent is working (and asking).
  const approvalsPicker = (
    <SelectChip
      icon={<ShieldIcon className={`h-3.5 w-3.5 ${approvalMode === "auto" ? "text-vs-warn" : "text-vs-muted"}`} />}
      value={approvalMode}
      onChange={changeApprovalMode}
      options={[
        { id: "ask", label: "Ask first", description: "Manual: the agent waits here for you to allow each command, web link or connector." },
        { id: "auto", label: "Auto-approve", description: "Auto: the agent runs commands, opens links and uses connectors on your computer without asking." },
      ]}
      title="Approvals"
    />
  );
  // When the turn being streamed here started, for the working card's elapsed time.
  const liveTurnStart = [...turns].reverse().find((turn) => turn.role === "agent" && turn.streaming)?.startedAt ?? null;

  // Refs the live event handlers read, so the one-time subscription below never
  // closes over stale state.
  const enteredRef = useRef<AgentRun | null>(null);
  const localRunIdRef = useRef<string | null>(null); // the run this tab is streaming
  const lastLocalRunIdRef = useRef<string | null>(null); // the last run this tab drove to a finish
  const liveTurnIdRef = useRef<string | null>(null); // the agent turn being followed
  useEffect(() => {
    enteredRef.current = entered;
  }, [entered]);

  // Candidate chats for both "import context…" (fresh compose only) and the
  // composer's @-mention picker (any time). Reloaded whenever the entered run
  // changes, since a run may have just finished and become referenceable.
  useEffect(() => {
    let cancelled = false;
    fetchForkableRuns(sessionId).then((res) => {
      if (!cancelled) setForkableRuns(res.runs);
    });
    fetchMentionTargets(sessionId).then((rooms) => {
      if (!cancelled) setMentionTargets(rooms);
    });
    return () => {
      cancelled = true;
    };
  }, [sessionId, entered]);

  /** Load a run's stored conversation into the panel. */
  async function loadRun(target: AgentRun) {
    const generation = ++historyGeneration.current;
    pinned.current = true; // a chat opens at its latest message
    setError(null);
    setHistoryFailed(false);
    liveTurnIdRef.current = null;
    const agentName = agents?.find((a) => a.id === target.agentId)?.name ?? target.agentId;
    setTurns([]);
    try {
      const { messages } = await fetchRun(sessionId, target.id);
      if (generation !== historyGeneration.current || enteredRef.current?.id !== target.id) return;
      // Every stored turn shows — replies, notices, warnings, errors, the
      // changed-files record. The old blanket drop of system turns on
      // completed runs guarded against a stderr transcript being stored on
      // success; the server no longer stores stderr except on failure,
      // where it is exactly the thing to show.
      //
      // Stored "tool" turns are the agent's own machinery. They belong to the
      // reply they led to, exactly as a live run shows them: collect each run
      // of them and hand them to the next agent turn as its trace.
      const restored: Turn[] = [];
      let pendingSteps: string[] = [];
      for (const message of messages) {
        if (message.role === "tool") {
          pendingSteps.push(message.body);
          continue;
        }
        const role: Turn["role"] = message.role === "user" ? "user" : message.role === "system" ? "system" : "agent";
        restored.push({
          id: uid(),
          role,
          text: message.body,
          attachments: message.attachments,
          activities: role === "agent" && pendingSteps.length ? pendingSteps : undefined,
          author: message.authorName ?? null,
          agentName: role === "agent" ? agentName : null,
        });
        if (role === "agent") pendingSteps = [];
      }
      // Steps with no reply after them (a cancelled or still-syncing turn) are
      // still worth showing on their own.
      if (pendingSteps.length) restored.push({ id: uid(), role: "agent", text: "", activities: pendingSteps, author: null, agentName });
      setTurns(restored);
    } catch {
      if (generation !== historyGeneration.current) return;
      setHistoryFailed(true);
      setError("We couldn’t load this chat. Check your internet connection and try again. You don’t need a connected computer to read saved messages.");
    }
  }

  /** Append a live output chunk to the agent turn of a run we are following. */
  function appendFollowChunk(chunk: string) {
    setTurns((prev) => {
      const next = [...prev];
      if (liveTurnIdRef.current === null) {
        const tid = uid();
        liveTurnIdRef.current = tid;
        next.push({
          id: tid,
          role: "agent",
          text: chunk,
          streaming: true,
          agentName: enteredRef.current?.agentId ?? "Agent",
        });
      } else {
        const index = next.findIndex((turn) => turn.id === liveTurnIdRef.current);
        if (index >= 0) next[index] = { ...next[index], text: next[index].text + chunk };
      }
      return next;
    });
  }

  // The conversation follows whichever run is entered: load its stored turns,
  // or clear to compose a fresh one. Deferred so no state is set in the effect body.
  //
  // The exception is a run this tab just started: it is entered so follow-ups
  // continue it, but its output is already streaming into `turns` locally, so
  // reloading from the store here would wipe the live tail. Skip it.
  useEffect(() => {
    liveTurnIdRef.current = null;
    let cancelled = false;
    queueMicrotask(() => {
      if (cancelled) return;
      if (entered && entered.id !== localRunIdRef.current) void loadRun(entered);
      else if (!entered) { historyGeneration.current += 1; setTurns([]); }
    });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [entered?.id]);

  // Realtime: follow the entered run as its output streams from whoever is
  // running it. (The run list itself is refreshed by the room, not here.)
  useEffect(() => {
    const stream = openSessionStream(sessionId, {
      onRunOutput: (event) => {
        if (event.runId === localRunIdRef.current) return; // our own run streams locally
        if (enteredRef.current?.id !== event.runId) return; // not the run in view
        if (event.stream !== "out") return; // stderr is internal processing, not shown
        appendFollowChunk(event.chunk);
      },
      onRunTurn: (event) => {
        if (event.runId === localRunIdRef.current && !event.inputId) return;
        if (enteredRef.current?.id !== event.runId) return;
        // A prompt from the runner shows immediately; agent output arrives via
        // run.output and is reconciled on finish, so it is not appended here.
        if (event.role === "user") {
          setTurns((prev) => [
            ...prev,
            { id: uid(), role: "user", text: event.body, attachments: event.attachments, author: event.authorName ?? "Prompt" },
          ]);
        }
      },
      // The chat's own name settling in, or its driver renaming it in another
      // tab. Held locally rather than refetching the run: the heading
      // cross-fades, and a refetch would land the new text with no transition.
      onRunRenamed: (event) => setRenamedTitle({ runId: event.runId, title: event.title }),
      onRunFinished: (event) => {
        // Reload the entered run so its complete, stored output replaces the
        // live tail (which may have started mid-run). Only for a run driven by
        // someone else — one we drove locally is already fully rendered.
        const current = enteredRef.current;
        if (
          current?.id === event.runId &&
          event.runId !== localRunIdRef.current &&
          event.runId !== lastLocalRunIdRef.current
        ) {
          liveTurnIdRef.current = null;
          void loadRun(current);
        }
      },
    });
    return () => stream.close();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId]);

  useEffect(() => {
    let cancelled = false;
    let generation = 0;
    const refresh = () => { const current = ++generation; void fetchAgents().then((response) => {
      if (cancelled || current !== generation) return;
      setAgents(response.agents);
      setAgentsError(null);
      setServerCanRun(response.canRun);
      setBlockedReason(response.reason);
      setParallelChats(response.parallelChats);
      // Pre-select a ready agent, so the common case is one click: the one this
      // member last used on this device, else Codex, else the first installed.
      if (!connectedRef.current) {
        const chosen = preferredAgent(response.agents);
        if (chosen) {
          const picks = savedPicks(response.agents.find((agent) => agent.id === chosen));
          connectedRef.current = chosen;
          setConnected(chosen);
          setModel(picks.model);
          setEffort(picks.effort);
        }
      }
    }).catch(() => {
      if (!cancelled && current === generation) {
        setServerCanRun(false);
        setAgentsError("We couldn’t check your AI tools. Your saved chats are still available. Try again before sending a message.");
      }
    }); };
    refresh();
    const stream = openUserStream(type => { if (type === "devices.changed") refresh(); }, refresh);
    window.addEventListener("focus", refresh);
    return () => {
      cancelled = true;
      stream.close();
      window.removeEventListener("focus", refresh);
    };
  }, [computerStatus]);

  // Send a held prompt once the import commits. `ask` is redefined every
  // render, so it is reached through a ref rather than listed as a dependency.
  const askRef = useRef(ask);
  useEffect(() => { askRef.current = ask; });
  useEffect(() => {
    if (importingRepo || !heldPrompt) return;
    // Deferred rather than run here: the repo this should target only exists
    // now, ask() reads the current selection, and clearing the hold inside the
    // effect body would cascade a render.
    const held = heldPrompt;
    const timer = setTimeout(() => {
      setHeldPrompt(null);
      // A failed import leaves the old repository selected, so running the
      // prompt would answer about the wrong code. Hand it back instead.
      if (importFailed) composer.current?.insertPrompt(held.prompt);
      else askRef.current(held.prompt, held.contextRefs, held.attachments, held.fileRefs);
    }, 0);
    return () => clearTimeout(timer);
  }, [importingRepo, heldPrompt, importFailed]);

  // Follow the conversation as it grows, but only while the reader is at the
  // bottom. Snapping on every update (each streamed token) made a long chat
  // impossible to scroll back through while an agent worked.
  const pinned = useRef(true);
  const [awayFromLatest, setAwayFromLatest] = useState(false);
  useEffect(() => {
    const element = scroller.current;
    if (element && pinned.current) element.scrollTop = element.scrollHeight;
  }, [turns]);
  function onConversationScroll() {
    const element = scroller.current;
    if (!element) return;
    const atBottom = element.scrollHeight - element.scrollTop - element.clientHeight < 80;
    pinned.current = atBottom;
    setAwayFromLatest(!atBottom);
  }
  function jumpToLatest() {
    // Instant, not smooth: a smooth scroll reports positions short of the
    // bottom while new output keeps moving it, and would unpin again.
    const element = scroller.current;
    if (!element) return;
    pinned.current = true;
    setAwayFromLatest(false);
    element.scrollTop = element.scrollHeight;
  }

  async function recheck() {
    setRefreshing(true);
    try {
      const response = await fetchAgents(true);
      setAgents(response.agents);
      setAgentsError(null);
      setServerCanRun(response.canRun);
      setBlockedReason(response.reason);
      setParallelChats(response.parallelChats);
    } catch { setServerCanRun(false); setAgentsError("We couldn’t check your AI tools. Check your internet connection and try again."); }
    finally { setRefreshing(false); }
  }

  // Switching provider restores that agent's own model/effort picks (or the
  // defaults), since the options differ per agent.
  function selectProvider(id: string) {
    const picks = savedPicks(agents?.find((agent) => agent.id === id));
    connectedRef.current = id;
    setConnected(id);
    setModel(picks.model);
    setEffort(picks.effort);
    setInstallFor(null);
  }
  // Remembered on this device, so a reload keeps the member's choice.
  useEffect(() => { if (connected) rememberChoice(connected, model, effort); }, [connected, model, effort]);

  function ask(prompt: string, contextRefs?: string[], attachments: MessageAttachment[] = [], fileRefs: string[] = []) {
    pinned.current = true; // sending follows the reply
    if (importingRepo) {
      setHeldPrompt({ prompt, contextRefs, attachments, fileRefs });
      return;
    }
    if (!connected || running || !ready || (entered && (!enteredIsMine || ["running", "queued"].includes(entered.status)))) return;
    if (!modelAvailable || !effortAvailable) { setError("Choose an available model and reasoning effort before sending."); return; }
    setRunning(true);
    setError(null);

    // Continue your own run — including one that already finished, so a
    // follow-up keeps the same chat instead of opening a new one every time.
    // A message on someone else's run forks into a fresh run of your own
    // rather than editing theirs.
    const continuing = entered && entered.driverUserId === myId ? entered.id : undefined;
    const agentId = connected;
    const agentName = agents?.find((a) => a.id === agentId)?.name ?? agentId;

    // Claim the run as ours *before* the request. When continuing, the room
    // broadcasts this run's prompt and output back to us, and those can arrive
    // ahead of the local stream's "start" event — without this, they'd slip
    // past the own-run guard in the realtime handlers and render a second time.
    // A fresh run's id isn't known until "start", but it isn't entered yet
    // either, so its broadcasts are already ignored until then.
    if (continuing) localRunIdRef.current = continuing;

    // A fork pick only ever applies to the fresh run it was made for.
    const forkFromRun = continuing ? undefined : forkFromRunId || undefined;
    const forkSource = forkFromRun ? forkableRuns.find((r) => r.id === forkFromRun) : undefined;
    onForkFromChange(null);

    // Continuing appends to the entered run; a fresh run starts a clean thread.
    // On a fork, lead with a notice so the imported memory is visible up top —
    // the messages themselves stay in the agent's context, not the transcript.
    const userTurn: Turn = { id: uid(), role: "user", text: prompt, attachments: attachments.length ? attachments : undefined, author: "You" };
    setTurns((prev) => {
      if (continuing) return [...prev, userTurn];
      if (forkSource) {
        return [
          { id: uid(), role: "system", text: `Imported context from #${forkSource.sessionName}` },
          userTurn,
        ];
      }
      return [userTurn];
    });

    // The agent's turn is created up front and shows "Thinking…" until real
    // output lands; it is filled only from stdout (the finished reply). stderr
    // is the CLI's internal processing — its banner, reasoning, token tally —
    // and is never shown in the chat.
    const agentTurnId = uid();

    // The repo pick only shapes a fresh chat; a continuation stays on the repo
    // its run started with (the server enforces the same).
    const repoForRun = continuing ? undefined : repoId || undefined;

    run.current = runAgent(
      {
        sessionId,
        agentId,
        prompt: planMode ? `Plan mode: Analyze the request and propose a plan. Do not edit files or execute commands that change state. Wait for approval before implementing.\n\n${prompt}` : prompt,
        runId: continuing,
        controlVersion: entered?.controlVersion,
        model,
        effort,
        forkFromRunId: forkFromRun,
        contextRefs,
        repoId: repoForRun,
        isolation: !continuing && parallel && parallelChats ? "isolated" : undefined,
        attachmentIds: attachments.length ? attachments.map((file) => file.id) : undefined,
        permissionMode: approvalMode,
        fileRefs: fileRefs.length ? fileRefs : undefined,
      },
      {
        onEvent: (event) => {
          if (event.t === "start") {
            localRunIdRef.current = event.runId; // so the room broadcast of our own run is ignored
            setTurns((prev) => [
              ...prev.filter((turn) => !turn.waiting),
              {
                id: agentTurnId,
                role: "agent",
                text: "",
                agentName,
                streaming: true,
                startedAt: Date.now(),
              },
            ]);
            onRunsChanged(); // the new run shows in the sidebar
            // Enter a freshly opened run so the next prompt continues it rather
            // than starting yet another. (A continuation is already entered.)
            if (!continuing && onEntered) {
              void fetchRun(sessionId, event.runId)
                .then(({ run }) => onEntered(run))
                .catch(() => {});
            }
          } else if (event.t === "out") {
            setTurns((prev) => {
              const next = [...prev];
              const index = next.findIndex((turn) => turn.id === agentTurnId);
              if (index >= 0) next[index] = { ...next[index], text: next[index].text + event.d };
              return next;
            });
          } else if (event.t === "err") {
            // stderr is part of what the AI said, so it is never dropped — it
            // collects under the turn as an openable log, and pops open by
            // itself when the run fails.
            setTurns((prev) => {
              const next = [...prev];
              const index = next.findIndex((turn) => turn.id === agentTurnId);
              if (index >= 0) {
                next[index] = {
                  ...next[index],
                  errText: ((next[index].errText ?? "") + event.d).slice(-16000),
                };
              }
              return next;
            });
          } else if (event.t === "think") {
            // The reasoning trace, shown live and capped so a long chain of
            // thought stays readable rather than unbounded.
            setTurns((prev) => {
              const next = [...prev];
              const index = next.findIndex((turn) => turn.id === agentTurnId);
              if (index >= 0) {
                next[index] = {
                  ...next[index],
                  thinking: ((next[index].thinking ?? "") + event.d).slice(-8000),
                };
              }
              return next;
            });
          } else if (event.t === "act") {
            // One tool step. Keep the most recent so the trace doesn't grow
            // without bound on a long, tool-heavy run.
            setTurns((prev) => {
              const next = [...prev];
              const index = next.findIndex((turn) => turn.id === agentTurnId);
              if (index >= 0) {
                next[index] = {
                  ...next[index],
                  activities: [...(next[index].activities ?? []), event.d].slice(-50),
                };
              }
              return next;
            });
          } else if (event.t === "notice") {
            // The server's "queued" notice is a live state, not history: it shows
            // until the computer picks the turn up, then gives way to the agent.
            const waiting = event.message.startsWith("Queued for your runner");
            setTurns((prev) => [...prev, waiting
              ? { id: uid(), role: "system", text: "Waiting for your computer to start…", waiting: true }
              : { id: uid(), role: "system", text: event.message }]);
          } else if (event.t === "exit") {
            const failed = event.code !== 0;
            const summary = failed
              ? `Run failed after ${(event.ms / 1000).toFixed(1)}s${event.code !== null ? ` (exit ${event.code})` : ""}`
              : `Finished in ${(event.ms / 1000).toFixed(1)}s` +
                (event.committed ? ` · committed ${event.headSha?.slice(0, 8)}` : " · no file changes");
            setTurns((prev) => {
              const next = prev.map((turn) =>
                turn.id === agentTurnId ? { ...turn, streaming: false, failed } : turn,
              );
              next.push({ id: uid(), role: "system", text: summary });
              // Which files changed, line counts included — same wording as
              // the durable system turn everyone else sees via the room feed.
              if (event.changes && event.changes.length > 0) {
                const added = event.changes.reduce((sum, file) => sum + file.added, 0);
                const removed = event.changes.reduce((sum, file) => sum + file.removed, 0);
                next.push({
                  id: uid(),
                  role: "system",
                  text: [
                    `Changed ${event.changes.length} file${event.changes.length === 1 ? "" : "s"} (+${added} −${removed})`,
                    ...event.changes.map((file) => `· ${file.path}  +${file.added} −${file.removed}`),
                  ].join("\n"),
                });
              }
              return next;
            });
          }
        },
        onError: setError,
        onDone: () => {
          setRunning(false);
          // Remember the run we just drove, so the room's run.finished broadcast
          // does not reload it over our own already-rendered output (which
          // includes the local "Finished in…" summary).
          lastLocalRunIdRef.current = localRunIdRef.current;
          localRunIdRef.current = null;
          onRunsChanged();
        },
      },
    );
  }

  const active = agents?.find((agent) => agent.id === connected) ?? null;
  // Tools are signed in on the member's own computer; its runner reports them.
  const computerUnavailable = computerStatus !== "connected";
  const ready = !!active?.installed && serverCanRun && canRun && !computerUnavailable;
  const hasConversation = turns.length > 0;

  const activeSpec = connected ? agentById(connected) : undefined;
  const installedAgents = agents?.filter((agent) => agent.installed) ?? [];
  const inventory = active?.models ?? { choices: activeSpec?.models ?? [], source: "CLI defaults", checkedAt: 0, refreshedAt: null, stale: false };
  const selectedModel = inventory.choices.find(choice => choice.id === model);
  const modelAvailable = !!selectedModel;
  const efforts = selectedModel?.efforts ?? activeSpec?.efforts ?? [];
  const effortAvailable = !effort || efforts.some(choice => choice.id === effort);

  // Every visible room in the project — including empty ones — for the @ picker,
  // with only the chat currently in view removed (you can't reference the one
  // you're typing into).
  const mentionRooms: MentionRoom[] = mentionTargets.map((room) => ({
    ...room,
    chats: entered ? room.chats.filter((chat) => chat.runId !== entered.id) : room.chats,
  }));

  // Only offered while composing a fresh chat — a continuation already has a
  // memory of its own.
  const forkOptions: AgentChoice[] = [
    { id: "", label: "Import context…" },
    ...forkableRuns.map((candidate) => ({
      id: candidate.id,
      label: `${candidate.sessionName} · ${candidate.title ?? candidate.agentId}`,
    })),
  ];

  // The repo the next fresh chat works on. "__import__" is the picker's action
  // row: choosing it opens project creation instead of selecting anything.
  const repoChoices: AgentChoice[] = [
    ...repoOptions,
    { id: "__import__", label: importingRepo ? "Importing…" : "Add repository…" },
  ];

  const composerFooter =
    ready && activeSpec ? (
      <div className="room-composer-tools flex min-w-0 flex-1 flex-wrap items-center gap-1">
        {!entered && (
          <>
            <SelectChip
              icon={<GitBranchIcon className="h-3.5 w-3.5 text-vs-muted" />}
              value={repoId ?? ""}
              onChange={(id) => {
                if (id === "__import__") {
                  if (!importingRepo) onImportRepo();
                  return;
                }
                onRepoChange(id || null);
              }}
              options={repoChoices}
              title="Repository this chat works on"
            />
            <span className="mx-0.5 h-3.5 w-px bg-vs-border" />
          </>
        )}
        <SelectChip
          icon={<SparkleIcon className="h-3.5 w-3.5 text-vs-accent" />}
          value={connected ?? ""}
          onChange={selectProvider}
          options={installedAgents.map((agent) => ({ id: agent.id, label: agent.name }))}
          title="Provider"
        />
        <span className="mx-0.5 h-3.5 w-px bg-vs-border" />
        <ModelPicker inventory={inventory} value={model} onChange={value => { setModel(value); setEffort(""); }} provider={active!.name} onRefresh={() => void recheck()} refreshing={refreshing} />
        {efforts.length > 0 && (
          <>
            <span className="mx-0.5 h-3.5 w-px bg-vs-border" />
            <SelectChip
              icon={<BarsIcon className="h-3 w-3 text-vs-muted" />}
              value={effort}
              onChange={setEffort}
              options={[{ id: "", label: "Auto" }, ...efforts.filter(choice => choice.id)]}
              title="Reasoning effort"
            />
          </>
        )}
        <button type="button" aria-pressed={effort === "low"} disabled={!efforts.some(option => option.id === "low")} title="Fast Mode uses low reasoning effort when the selected model supports it" onClick={() => setEffort(effort === "low" ? "" : "low")} className="composer-control composer-toggle">ϟ Fast</button>
        <button type="button" aria-pressed={planMode} title="Ask for a plan before making changes" onClick={() => setPlanMode(value => !value)} className="composer-control composer-toggle">Plan</button>
        {!entered && approvalsPicker}
        {!entered && parallelChats && (
          <button type="button" aria-pressed={parallel} onClick={() => setParallel(value => !value)}
            title="Work on a branch of its own, so this chat can run alongside your others. Review and merge it into the room when it's ready."
            className="composer-control composer-toggle">⑂ Parallel</button>
        )}
        {!entered && forkableRuns.length > 0 && (
          <>
            <span className="mx-0.5 h-3.5 w-px bg-vs-border" />
            <SelectChip
              value={forkFromRunId ?? ""}
              onChange={(id) => onForkFromChange(id || null)}
              options={forkOptions}
              title="Import context from…"
            />
          </>
        )}
      </div>
    ) : undefined;

  // Name the codebase an opened chat works on — legible at a glance when a
  // room mixes chats across several repos (only imported ones are called out).
  const enteredRepoLabel = entered?.repoId
    ? (repoOptions.find((option) => option.id === entered.repoId)?.label ?? "removed repo")
    : null;
  async function assignChatTask(person: MentionPerson, body: string) {
    if (!canRun) throw new Error("You need edit access to assign a task.");
    if (!myId) throw new Error("Your account is still loading. Try again in a moment.");
    if (isSelfAssignment(myId, person.userId)) throw new Error(SELF_ASSIGNMENT_ERROR);
    const payload = JSON.stringify({ sessionId, ...(entered ? { runId: entered.id } : { newChat: { repoId: repoId ?? null, agentId: active?.id ?? "codex" } }), assigneeId: person.userId, body });
    if (taskRequest.current?.payload !== payload) taskRequest.current = { payload, id: crypto.randomUUID() };
    const response = await fetch("/api/tasks", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ...JSON.parse(payload), id: taskRequest.current.id }) });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error ?? "Could not assign task.");
    taskRequest.current = null;
    setTaskRevision(value => value + 1);
    onRunsChanged();
    if (!entered) {
      // Saving a human task creates its source chat, without starting the AI.
      // A failed follow-up read must not turn a saved task into a failed send.
      void fetchRun(sessionId, result.runId).then(({ run }) => onEntered?.(run)).catch(() => {});
    }
  }
  const liveTitle = entered && renamedTitle?.runId === entered.id ? renamedTitle.title : entered?.title;
  const chatTitle = liveTitle ?? (entered ? "Agent run" : "New chat");
  const repoLabel = enteredRepoLabel ?? repoOptions.find(option => option.id === (entered ? entered.repoId ?? "" : repoId ?? ""))?.label;
  const executionLabel = active?.execution === "runner" ? "Paired computer" : "App’s machine";
  const executionDetail = active?.execution === "runner"
    ? "Tasks run in local worktrees on your paired computer, using its tools and AI account."
    : "Tasks run on the machine hosting this app. Connect your computer to use its local worktrees instead.";

  return (
    <aside className="flex h-full min-h-0 w-full flex-col bg-vs-editor">
      <header className={`ai-chat-header flex min-w-0 shrink-0 flex-wrap items-center gap-3 ${entered ? "" : "border-b border-vs-border"}`}>
        {/* A basis keeps the title readable; the actions wrap below it instead
            of squeezing the chat's name down to an ellipsis. */}
        <div className="min-w-0 flex-1 basis-44">
          <ChatTitle title={chatTitle} runId={entered?.id ?? null} />
          <div className="mt-0.5 flex min-w-0 items-center gap-1.5 text-[11px] text-vs-muted">
            {repoLabel && <span className="flex min-w-0 items-center gap-1.5" title={repoLabel}><GitBranchIcon className="h-3 w-3 shrink-0" /><span className="truncate">{repoLabel}</span></span>}
            {repoLabel && active?.installed && <span aria-hidden="true">·</span>}
            {active?.installed && <span className="flex shrink-0 items-center gap-1.5" title={executionDetail}><TerminalIcon className="h-3 w-3" />{executionLabel}</span>}
          </div>
        </div>
        <div className="flex min-w-0 flex-wrap items-center gap-1">
        {entered &&
          (enteredIsMine ? (
            <button
              type="button"
              onClick={onNewRun}
              className="flex items-center gap-1 rounded-md px-1.5 py-1 text-[11px] text-vs-muted transition hover:bg-vs-hover hover:text-vs-fg"
            >
              <PlusIcon className="h-3 w-3" />
              New
            </button>
          ) : (
            <button
              type="button"
              onClick={() => onForkEntered(entered)}
              title={`Fork ${entered.startedByName}'s chat: a new chat that imports its context`}
              className="flex items-center gap-1 rounded-md px-1.5 py-1 text-[11px] text-vs-muted transition hover:bg-vs-hover hover:text-vs-fg"
            >
              <GitBranchIcon className="h-3 w-3" />
              Copy chat
            </button>
          ))}
        {/* Briefing and synchronized history are reference material, not part of
            the conversation, so they open from here instead of sitting above it. */}
        {entered?.isolation === "isolated" && <button type="button" onClick={() => setBranchOpen(true)} title="Review this parallel chat's changes and merge them into the room" className="rounded px-1.5 py-1 text-[11px] text-vs-accent transition hover:bg-vs-hover">Changes</button>}
        {entered && enteredIsMine && myId && approvalsPicker}
        {entered && <button type="button" onClick={() => setBriefingOpen(true)} className="rounded px-1.5 py-1 text-[11px] text-vs-muted transition hover:bg-vs-hover hover:text-vs-fg">Briefing</button>}
        {entered && <WorkspaceHistory key={`history-${entered.id}`} run={entered} userId={myId} />}
        <button ref={setProvidersButton} type="button" onClick={() => setShowProviders(previous => !previous)} aria-haspopup="dialog" aria-expanded={showProviders} className={`rounded px-1.5 py-1 text-[11px] transition hover:bg-vs-hover ${showProviders ? "bg-vs-hover text-vs-fg" : "text-vs-muted"}`}>Providers</button>
        {entered && myUserId && <CollaborationControls key={`collaboration-${entered.id}`} runId={entered.id} userId={myUserId} />}
        <span className="ml-1 hidden sm:inline-flex"><WatchingCluster members={members} /></span>
        {onClose && <button type="button" onClick={onClose} aria-label="Close AI chat" className="rounded-md p-1 text-vs-muted hover:bg-vs-hover hover:text-vs-fg"><CloseIcon className="h-3 w-3" /></button>}
        </div>
      </header>
      {actionsHost && createPortal(<>
        <button type="button" disabled={!canRun} onClick={() => setAssignOpen(true)} className="rounded px-2 py-1.5 text-xs text-vs-muted hover:bg-vs-hover disabled:opacity-40">Assign Tasks</button>
        {entered ? <HandoffPanel key={`handoff-${entered.id}`} compact run={entered} userId={myId} canEdit={canRun} isOwner={isOwner} onUpdated={updated => onEntered?.(updated)} /> : <button type="button" disabled title="Start a chat before handing it off" className="rounded px-2 py-1.5 text-xs text-vs-muted opacity-40">Handoff</button>}
        <button type="button" disabled={!ready || running || !!entered && (!enteredIsMine || ["running", "queued"].includes(entered.status))} title="Ask AI to draft a code review; this does not request teammate approval" onClick={() => { onShowConversation?.(); composer.current?.insertPrompt("Review the changes in this repository for bugs and regressions. Explain your findings with file references before changing any files."); }} className="flex items-center gap-1 rounded px-2 py-1.5 text-xs text-vs-accent hover:bg-vs-hover disabled:opacity-40"><EyeIcon className="h-3 w-3" />Ask AI to review</button>
      </>, actionsHost)}
      {assignOpen && <Modal title="Assign Tasks" description="Type @ and choose a teammate, then describe the task." onClose={() => setAssignOpen(false)}>
        <Composer key={entered?.id ?? "new"} placeholder="@teammate Describe the task…" disabled onSend={() => {}} people={taskPeople} onAssignTask={assignChatTask} narrow />
        {taskPeople.length === 0 && <p className="text-sm text-vs-muted">No teammates are available to assign. Invite a teammate to this room first.</p>}
      </Modal>}
      {branchOpen && entered?.isolation === "isolated" && <Modal title="Parallel chat changes" width="max-w-3xl"
        description="What this chat would bring into the room. Merging creates a merge commit on the room branch; Publish then shares it with the project."
        onClose={() => setBranchOpen(false)}>
        <ChatBranchPanel key={`branch-${entered.id}`} sessionId={sessionId} run={entered} myUserId={myUserId} canEdit={canRun} isOwner={isOwner}
          onAskAgent={prompt => { setBranchOpen(false); onShowConversation?.(); composer.current?.insertPrompt(prompt); }} />
      </Modal>}
      {briefingOpen && entered && <Modal title="Conversation briefing" description="A starting point for joining the work. AI reports are unverified." onClose={() => setBriefingOpen(false)}>
        <BriefingCard key={`briefing-${entered.id}`} runId={entered.id} expanded bare />
      </Modal>}

      {/* Once an agent is ready the provider/model/capacity live in the composer
          footer; the full selector is only for connecting or installing one.
          Before anything is set up it is the panel's first step, so it sits
          inline; afterwards it is a menu, and opens over the conversation. */}
      {!showProviders && !entered && !ready && serverCanRun && !computerUnavailable && (
        <div className="vs-scroll max-h-[35%] shrink-0 overflow-y-auto">
          {active?.installed && <p className="px-4 pt-2 text-xs leading-5 text-vs-muted">{executionDetail}</p>}
          <AgentSelector
            agents={agents}
            connected={connected}
            installFor={installFor}
            refreshing={refreshing}
            onSelect={selectProvider}
            onToggleInstall={(id) => setInstallFor((shown) => (shown === id ? null : id))}
            onRecheck={recheck}
          />
        </div>
      )}
      {showProviders && (
        <ProvidersPopover anchor={providersButton} onClose={closeProviders}>
          <AgentSelector
            variant="menu"
            detail={active?.installed ? executionDetail : null}
            agents={agents}
            connected={connected}
            installFor={installFor}
            refreshing={refreshing}
            onSelect={(id) => { selectProvider(id); closeProviders(); }}
            onToggleInstall={(id) => setInstallFor((shown) => (shown === id ? null : id))}
            onRecheck={recheck}
          />
        </ProvidersPopover>
      )}

      {agentsError && (
        <Note tone="warn">{agentsError} <button type="button" disabled={refreshing} onClick={() => void recheck()} className="ml-1 underline">{refreshing ? "Checking…" : "Try again"}</button></Note>
      )}
      {!serverCanRun && !agentsError && !computerUnavailable && blockedReason && (
        <Note tone="warn">Your computer is connected. Set up an AI tool on it before sending a message. <button type="button" onClick={onSetUpAi} className="ml-1 font-medium underline">Set up AI</button></Note>
      )}
      {!canRun && (
        <Note tone="warn">You can read this chat. Ask a project manager for edit access to send AI requests.</Note>
      )}
      {/* Say plainly that the message is kept and why it has not run. Silently
          swallowing it, or running it against a partly written repository,
          are both worse than a short wait. */}
      {heldPrompt && (
        <Note tone="warn">
          Your message is waiting for the import to finish, then it will send.
          {" "}
          <button type="button" onClick={() => { const held = heldPrompt; setHeldPrompt(null); composer.current?.insertPrompt(held.prompt); }} className="ml-1 font-medium underline">
            Edit it instead
          </button>
        </Note>
      )}

      <div className="relative flex min-h-0 flex-1 flex-col">
      <div ref={scroller} onScroll={onConversationScroll} data-scroller="conversation" className="vs-scroll min-h-0 flex-1 overflow-y-auto overflow-x-hidden">
        {hasConversation ? (
          <Conversation turns={turns} sessionId={sessionId} />
        ) : (
          <EmptyState
            ready={ready}
            hasFiles={hasFiles}
            computerUnavailable={computerUnavailable}
            agentName={active?.name ?? null}
            onExample={prompt => composer.current?.insertPrompt(prompt)}
          />
        )}
        {error && (
          <p role="alert" className="mx-3 mb-3 flex flex-wrap items-start gap-2 rounded-md border border-vs-danger/40 bg-vs-danger/10 px-3 py-2 text-sm leading-5 text-vs-danger">
            <AlertIcon className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            {error}
            {historyFailed && entered && <button type="button" onClick={() => void loadRun(entered)} className="font-medium underline">Try again</button>}
          </p>
        )}
        {entered && myUserId && <div className="mx-auto max-w-4xl px-3"><TaskPanel key={entered.id} userId={myUserId} sessionId={sessionId} runId={entered.id} canAssign={canRun} showAssignAction={false} hideWhenEmpty refreshVersion={taskRevision} /></div>}
      </div>
      {awayFromLatest && hasConversation && (
        <button
          type="button"
          onClick={jumpToLatest}
          className="absolute bottom-3 left-1/2 inline-flex -translate-x-1/2 items-center gap-1.5 rounded-full border border-vs-border bg-vs-panel/95 px-3 py-1.5 text-[12px] text-vs-fg shadow-lg backdrop-blur transition hover:bg-vs-active"
        >
          <span aria-hidden>↓</span> Latest
        </button>
      )}
      </div>

      {entered && (
        <PermissionRequests
          key={`permissions-${entered.id}`}
          sessionId={sessionId}
          runId={entered.id}
          canAnswer={!!myId && entered.driverUserId === myId}
          onAutoApprove={() => changeApprovalMode("auto")}
          driverName={entered.driverName ?? null}
          agentName={agents?.find((agent) => agent.id === entered.agentId)?.name ?? entered.agentId}
        />
      )}
      {ready && !computerAsks && enteredIsMine && (
        <Note tone="warn">Your computer runs an older version of the Multicode AI app, so the agent can’t ask you before running a command or opening a link: those are refused instead. Update the desktop app (or the runner) and restart it.</Note>
      )}
      {ready && (!modelAvailable || !effortAvailable) && <p role="status" className="border-t border-vs-border px-3 py-2 text-xs text-vs-warn">Choose an available model{!effortAvailable ? " and effort" : ""}. The previous selection will not be replaced automatically.</p>}
      {running && !entered ? (
        // A brand-new chat before it is entered: the same working card, no queue yet.
        <div className="mx-auto w-full max-w-4xl px-3 pb-3 pt-2">
          <WorkingStatus agentName={active?.name ?? "Agent"} since={liveTurnStart} onDetach={() => run.current?.cancel()} />
        </div>
      ) : entered && !enteredIsMine ? (
        <>
        <div className="border-t border-vs-border p-3 text-sm text-vs-muted">You’re watching {entered.driverName}’s chat. Accept a handoff to continue here, or <button className="text-vs-accent underline" onClick={() => onForkEntered(entered)}>fork a new chat</button>.</div>
        </>
      ) : entered && (running || ["running", "queued"].includes(entered.status)) ? (
        // The queue below shows the working card and takes follow-ups.
        null
      ) : (
        <Composer
          inputRef={composer}
          key={`${entered?.id ?? "new"}:${repoId ?? "default"}`}
          disabled={!ready || !modelAvailable || !effortAvailable}
          tall
          narrow
          footer={composerFooter}
          mentions={mentionRooms}
          placeholder={
            !canRun ? "You have read-only access to this chat"
              : computerUnavailable ? "Connect your computer to send a message…"
              : !ready ? "Set up AI to send a message…"
              : entered && !enteredIsMine
                ? `Fork ${entered.startedByName}'s session with ${active!.name}…`
                : `Message ${active!.name}…${files?.length ? "  (@ to tag files)" : mentionRooms.length > 0 ? "  (@ chat references)" : ""}`
          }
          onSend={ask}
          attachTo={sessionId}
          files={files}
        />
      )}
      {entered && <QueuedMessages key={`queue-${entered.id}`} sessionId={sessionId} runId={entered.id} version={entered.controlVersion} active={running || ["running", "queued"].includes(entered.status)} canSend={!!enteredIsMine && canRun} agentId={entered.agentId}
        agentName={agents?.find((agent) => agent.id === entered.agentId)?.name ?? entered.agentId} startedAt={entered.startedAt} workingSince={liveTurnStart}
        onDetach={running ? () => run.current?.cancel() : undefined} moveDraft={text => composer.current?.insertPrompt(text)} />}
    </aside>
  );
}

/** The chat's name in the header, cross-faded as the chat names itself. */
function ChatTitle({ title, runId }: { title: string; runId: string | null }) {
  const { shown, className } = useTitleTransition(title, runId);
  return (
    <h2 className={`${className} truncate text-[13px] font-semibold text-vs-fg`} title={shown}>
      {shown}
    </h2>
  );
}

// ---------------------------------------------------------------------------
// Agent selector
// ---------------------------------------------------------------------------

/**
 * The provider menu, anchored under the header's "Providers" button.
 *
 * It used to drop into the panel's flow, shoving the conversation down with no
 * transition at all. Floating it on the same surface as the composer pickers
 * (`.composer-picker` colours, radius, shadow, and `picker-enter`) keeps the
 * transcript still and makes the menu read like the app's other menus.
 */
function ProvidersPopover({
  anchor,
  onClose,
  children,
}: {
  anchor: HTMLElement | null;
  onClose: () => void;
  children: ReactNode;
}) {
  const panel = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState<CSSProperties>({ visibility: "hidden" });

  useLayoutEffect(() => {
    // The top layer escapes the panel's overflow, so the menu is never clipped
    // by the column it opens from.
    const popup = panel.current;
    popup?.showPopover?.();
    function place() {
      const box = anchor?.getBoundingClientRect();
      if (!box) return;
      const width = Math.min(360, window.innerWidth - 24);
      const below = window.innerHeight - box.bottom - 16;
      const above = box.top - 16;
      const openBelow = below >= Math.min(280, above);
      setPosition({
        width,
        // Right-aligned to the trigger, which sits near the panel's edge.
        left: Math.max(12, Math.min(box.right - width, window.innerWidth - width - 12)),
        ...(openBelow ? { top: box.bottom + 8 } : { bottom: window.innerHeight - box.top + 8 }),
        maxHeight: Math.max(220, Math.min(460, openBelow ? below : above)),
      });
    }
    place();
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    return () => {
      if (popup?.hidePopover && popup.matches(":popover-open")) popup.hidePopover();
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", place, true);
    };
  }, [anchor]);

  useEffect(() => {
    function outside(event: PointerEvent) {
      const target = event.target as Node;
      if (!panel.current?.contains(target) && !anchor?.contains(target)) onClose();
    }
    document.addEventListener("pointerdown", outside);
    return () => document.removeEventListener("pointerdown", outside);
  }, [anchor, onClose]);

  return createPortal(
    <div
      ref={panel}
      popover="manual"
      role="dialog"
      aria-label="AI providers"
      style={position}
      className="providers-popover"
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.preventDefault();
          event.stopPropagation();
          onClose();
        }
      }}
    >
      {children}
    </div>,
    document.body,
  );
}

function AgentSelector({
  agents,
  connected,
  installFor,
  refreshing,
  onSelect,
  onToggleInstall,
  onRecheck,
  variant = "inline",
  detail: executionDetail = null,
}: {
  agents: AgentStatus[] | null;
  connected: string | null;
  installFor: string | null;
  refreshing: boolean;
  onSelect: (id: string) => void;
  onToggleInstall: (id: string) => void;
  onRecheck: () => void;
  /** "inline" is the first-run setup step; "menu" is the floating popover. */
  variant?: "inline" | "menu";
  /** Where turns execute, shown above the list when an agent is installed. */
  detail?: string | null;
}) {
  const detail = agents?.find((agent) => agent.id === installFor);
  const menu = variant === "menu";

  return (
    <div className={menu ? "flex min-h-0 flex-col" : "shrink-0 border-b border-vs-border px-2 py-2"}>
      <div className={menu ? "composer-picker-heading" : "mb-1.5 flex items-center justify-between px-1"}>
        <span className={menu ? "" : "text-[11px] font-semibold uppercase tracking-wider text-vs-muted"}>
          {menu ? "Providers" : "Agent"}
        </span>
        <button
          type="button"
          onClick={onRecheck}
          disabled={refreshing}
          className="flex items-center gap-1.5 rounded-md px-1.5 py-1 text-[12px] font-normal text-vs-muted transition hover:bg-vs-hover hover:text-vs-fg disabled:opacity-50"
        >
          {refreshing && <SpinnerIcon className="h-3 w-3" />}
          {refreshing ? "Checking…" : "Recheck"}
        </button>
      </div>

      {menu && executionDetail && (
        <p className="px-2.5 pb-2 text-[11px] leading-4 text-vs-muted">{executionDetail}</p>
      )}

      {agents === null ? (
        <p className="flex items-center gap-2 px-3 py-4 text-sm text-vs-muted">
          <SpinnerIcon className="h-3.5 w-3.5" />
          Looking for installed agents…
        </p>
      ) : (
        <div className={`flex flex-col gap-0.5 ${menu ? "vs-scroll min-h-0 overflow-y-auto px-0.5 pb-0.5" : ""}`}>
          {agents.map((agent, index) => {
            const selected = connected === agent.id;
            return (
              <button
                key={agent.id}
                type="button"
                aria-pressed={agent.installed ? selected : undefined}
                onClick={() => (agent.installed ? onSelect(agent.id) : onToggleInstall(agent.id))}
                // Rows settle in one after another so the list reads as opening
                // rather than appearing fully formed.
                style={menu ? { animationDelay: `${index * 40}ms` } : undefined}
                className={`provider-row group flex items-center gap-3 rounded-xl px-2.5 py-2.5 text-left ${
                  selected ? "provider-row-selected" : ""
                }`}
              >
                <span
                  className={`provider-mark flex h-8 w-8 shrink-0 items-center justify-center rounded-lg ${
                    agent.installed ? "bg-vs-accent/15 text-vs-accent" : "bg-vs-hover text-vs-muted"
                  }`}
                >
                  <SparkleIcon className="h-4 w-4" />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="flex items-center gap-1.5">
                    <span className="truncate text-[14px] font-medium text-vs-fg">{agent.name}</span>
                    {agent.installed && <StatusDot ok={!agent.auth || agent.auth.loggedIn} />}
                  </span>
                  <span className="mt-0.5 block truncate text-[11px] leading-4 text-vs-muted">
                    {agentSubtitle(agent)}
                  </span>
                </span>
                {agent.installed ? (
                  selected ? (
                    agent.auth && !agent.auth.loggedIn ? (
                      <span className="shrink-0 rounded-full bg-vs-accent/15 px-2 py-0.5 text-[10.5px] font-medium uppercase tracking-wide text-vs-accent">
                        Sign in
                      </span>
                    ) : (
                      <CheckIcon className="h-4 w-4 shrink-0 text-vs-accent" />
                    )
                  ) : (
                    <span className="shrink-0 text-[11px] text-vs-muted opacity-0 transition group-hover:opacity-100 group-focus-visible:opacity-100">
                      Select
                    </span>
                  )
                ) : (
                  <span className="shrink-0 rounded-full border border-vs-accent/30 px-2 py-0.5 text-[10.5px] uppercase tracking-wide text-vs-accent">
                    {installFor === agent.id ? "Hide" : "Install"}
                  </span>
                )}
              </button>
            );
          })}
        </div>
      )}

      {detail && !detail.installed && (
        <div className={`space-y-1.5 rounded-xl border border-vs-border bg-vs-editor p-2.5 ${menu ? "m-1.5 shrink-0" : "mt-1.5"}`}>
          <p className="text-[12px] leading-4 text-vs-fg">{detail.blurb}</p>
          <CopyLine command={detail.install.command} />
          {detail.install.alternative && <CopyLine command={detail.install.alternative} />}
          <p className="text-[11px] leading-4 text-vs-muted">
            Run it in a terminal, then press Recheck.{" "}
            <a
              href={detail.install.docs}
              target="_blank"
              rel="noreferrer"
              className="text-vs-accent underline-offset-2 hover:underline"
            >
              Docs
            </a>
          </p>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Account connection (sign in / out of the agent's own subscription)
// ---------------------------------------------------------------------------

/** Human label for a subscription tier the CLI reports (e.g. "max" → "Max"). */
function planLabel(plan: string): string {
  const known: Record<string, string> = { max: "Max", pro: "Pro", team: "Team", free: "Free" };
  return known[plan.toLowerCase()] ?? plan.charAt(0).toUpperCase() + plan.slice(1);
}

/** The one-line status under an agent's name in the selector. */
function agentSubtitle(agent: AgentStatus): string {
  if (!agent.installed) return `${agent.vendor} · not installed`;
  if (agent.auth) {
    if (!agent.auth.loggedIn) return "installed · not signed in";
    const who = agent.auth.email ?? "signed in";
    return agent.auth.plan ? `${who} · ${planLabel(agent.auth.plan)}` : who;
  }
  return agent.version ?? "connected";
}

// ---------------------------------------------------------------------------
// Conversation
// ---------------------------------------------------------------------------

function Conversation({ turns, sessionId }: { turns: Turn[]; sessionId: string }) {
  // Agent/system turns carry CLI framing (Codex's banner, model-manager error
  // logs, its echo of the prompt, the token tally). Strip it to the reply;
  // a turn that was nothing but noise is dropped entirely.
  const visible = turns.flatMap((turn) => {
    if (turn.role === "user") return [turn];
    // A still-streaming agent turn is kept even when empty — it renders the
    // "Thinking…" placeholder until stdout arrives.
    if (turn.streaming) return [turn];
    const text = cleanRunText(turn.text);
    // A turn that was nothing but noise is dropped, unless it carries the tool
    // steps for work that produced no reply.
    return text || turn.activities?.length ? [{ ...turn, text }] : [];
  });

  return (
    <div className="conversation-transcript mx-auto flex w-full max-w-4xl flex-col gap-8 px-10 py-8">
      {/* Metadata, not content: kept at chrome size so it never competes with
          the answer below it. */}
      <details className="text-[11px] text-vs-muted"><summary className="cursor-pointer">{plural(turns.reduce((count, turn) => count + (turn.activities?.length ?? 0), 0), "step")} · {plural(visible.filter(turn => turn.role !== "system").length, "message")}</summary><p className="mt-2">Steps are the agent’s tool calls in this conversation. Expand a response’s steps to inspect them.</p></details>
      {visible.map((turn) =>
        turn.role === "system" ? (
          <SystemLine key={turn.id} text={turn.text} waiting={turn.waiting} />
        ) : (
          <TurnBubble key={turn.id} turn={turn} sessionId={sessionId} />
        ),
      )}
    </div>
  );
}

/**
 * Removes the coding CLI's framing so only the assistant's reply shows.
 * Codex prints a startup banner, timestamped model-manager error logs, a
 * "Reading additional input…" notice, an echo of the prompt under a `codex`
 * marker, and a trailing token count. Non-Codex agents lack these markers, so
 * their output passes through unchanged.
 */
function cleanRunText(raw: string): string {
  if (!raw) return "";
  const isCodex = raw.includes("OpenAI Codex v");

  let text = raw
    .split("\n")
    .filter((line) => {
      const t = line.trimStart();
      if (/^\d{4}-\d{2}-\d{2}T[\d:.]+Z\s+(ERROR|WARN|WARNING|INFO|DEBUG|TRACE)\b/.test(t)) {
        return false;
      }
      if (t.startsWith("Reading additional input from stdin")) return false;
      return true;
    })
    .join("\n");

  // The token tally is never worth showing. Strip it wherever it appears —
  // "tokens used\n8,940" or inline "tokens used 8,940" — not just at the end.
  text = text.replace(/\n*tokens used\s+[\d,]+/gi, "");

  if (isCodex) {
    // The startup banner: "OpenAI Codex v…" through its closing rule.
    text = text.replace(/OpenAI Codex v[^\n]*\n-{3,}[\s\S]*?\n-{3,}\n?/, "");
    // Keep only what follows the last `codex` marker, dropping the prompt echo.
    const lastCodex = text.lastIndexOf("\ncodex\n");
    if (lastCodex >= 0) text = text.slice(lastCodex + "\ncodex\n".length);
    else if (text.startsWith("codex\n")) text = text.slice("codex\n".length);

    // Codex's canned "no real task" greeting is filler, not a reply — drop it
    // whether it stands alone or trails the actual output.
    const filler = /(?:^|\n)\s*(?:hi|hello|hey)?[.!,]?\s*what (?:do|would) you (?:want|like) to work on\??\s*$/i;
    text = text.replace(filler, "");
  }

  return text.trim();
}

function TurnBubble({ turn, sessionId }: { turn: Turn; sessionId: string }) {
  // The user's own prompts sit on the right as a bubble; the agent replies on
  // the left as rendered Markdown — the familiar assistant-chat layout.
  if (turn.role === "user") {
    const author = turn.author ?? "You";
    return (
      <div className="flex flex-col items-end gap-1">
        {author !== "You" && <span className="pr-1 text-[11px] text-vs-muted">{author}</span>}
        {turn.attachments?.length ? (
          <ul aria-label="Attached files" className="flex max-w-[85%] flex-wrap justify-end gap-1.5">
            {turn.attachments.map((file) => (
              <li key={file.id}>
                <a href={attachmentUrl(sessionId, file.id)} className="flex max-w-64 items-center gap-1.5 rounded-lg border border-vs-border px-2 py-1 text-[11px] text-vs-fg hover:bg-vs-hover" title={`Download ${file.name}`}>
                  <span className="truncate">{file.name}</span>
                  <span className="shrink-0 text-vs-muted">{formatBytes(file.size)}</span>
                </a>
              </li>
            ))}
          </ul>
        ) : null}
        <div className="human-message max-w-[85%] whitespace-pre-wrap break-words rounded-xl px-4 py-2.5 text-vs-fg">
          {turn.text}
        </div>
      </div>
    );
  }

  const hasReply = !!turn.text.trim();
  const hasTrace = !!turn.thinking?.trim() || (turn.activities?.length ?? 0) > 0;

  return (
    <article className="assistant-message flex min-w-0 gap-3">
      <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-vs-accent/15 text-vs-accent">
        <SparkleIcon className="h-4 w-4" />
      </span>
      <div className="min-w-0 flex-1">
        <header className="mb-1 flex items-center gap-2">
          <span className="truncate text-[14px] font-semibold text-vs-fg">
            {turn.agentName ?? "Agent"}
          </span>
          {turn.startedAt && (
            <LiveTimer startedAt={turn.startedAt} running={!!turn.streaming} />
          )}
        </header>
        {hasTrace && (
          <ActivityTrace
            thinking={turn.thinking}
            activities={turn.activities}
            live={!!turn.streaming && !hasReply}
          />
        )}
        {turn.streaming && !hasReply ? (
          hasTrace ? null : <p role="status" className="shimmer-text text-[15px] leading-6">Thinking</p>
        ) : (
          <>
            <Markdown text={turn.text} />
            {!turn.streaming && hasReply && <ReplyActions text={turn.text} />}
          </>
        )}
        {!!turn.errText?.trim() && (
          <details
            open={turn.failed}
            className="mt-2 rounded-lg border border-vs-border bg-vs-editor/60"
          >
            <summary
              className={`cursor-pointer px-3 py-1.5 text-[12px] ${turn.failed ? "text-vs-danger" : "text-vs-muted"}`}
            >
              {turn.failed ? "Run failed — agent log" : "Agent log"}
            </summary>
            <pre className="vs-scroll max-h-48 overflow-y-auto whitespace-pre-wrap break-words px-3 pb-2 font-mono text-[11px] leading-4 text-vs-muted">
              {turn.errText.trim()}
            </pre>
          </details>
        )}
      </div>
    </article>
  );
}

/** Under a finished reply: copy the whole answer as Markdown, as assistants do. */
function ReplyActions({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 1600);
    return () => clearTimeout(timer);
  }, [copied]);
  return (
    <div className="mt-2 flex items-center gap-1 text-[12px] text-vs-muted">
      <button
        type="button"
        onClick={() => void navigator.clipboard?.writeText(text.trim()).then(() => setCopied(true), () => {})}
        aria-label={copied ? "Reply copied" : "Copy reply"}
        className="inline-flex items-center gap-1.5 rounded-md px-1.5 py-1 transition hover:bg-vs-hover hover:text-vs-fg"
      >
        {copied ? <CheckIcon className="h-3.5 w-3.5 text-vs-success" /> : <FilesIcon className="h-3.5 w-3.5" />}
        {copied ? "Copied" : "Copy"}
      </button>
    </div>
  );
}

/** Ticking elapsed-seconds counter, like Conductor's run clock. Freezes when done. */
function LiveTimer({ startedAt, running }: { startedAt: number; running: boolean }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!running) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [running]);
  const secs = Math.max(0, Math.round((now - startedAt) / 1000));
  return (
    <span className="shrink-0 tabular-nums text-[11px] text-vs-muted" title="Elapsed">
      {secs}s
    </span>
  );
}

/**
 * The live "it's working" trace: what the agent is doing right now, as one
 * shimmering line, and its steps as a short timeline (finished ones checked,
 * the current one pulsing), with readable names instead of tool identifiers.
 * Open while the agent works, folded once the answer starts; a choice the
 * person makes sticks.
 */
function ActivityTrace({
  thinking,
  activities,
  live,
}: {
  thinking?: string;
  activities?: string[];
  live: boolean;
}) {
  const [userOpen, setUserOpen] = useState<boolean | null>(null);
  const open = userOpen ?? live;
  const steps = (activities ?? []).map(describeStep);
  const trace = thinking?.trim() ?? "";
  const current = live ? steps[steps.length - 1] : undefined;
  const count = steps.length ? `${steps.length} ${steps.length === 1 ? "step" : "steps"}` : "";

  return (
    <div className="mb-3">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setUserOpen(!open)}
        className="group inline-flex max-w-full items-center gap-2 rounded-full py-1 pr-2 text-[13px] text-vs-muted transition hover:text-vs-fg"
      >
        {live ? (
          <span className="shimmer-text truncate font-medium">{current ? `${current.label}${current.detail ? ` ${current.detail}` : ""}` : "Thinking"}</span>
        ) : (
          <span className="truncate">{count ? `Worked through ${count}` : "Reasoning"}</span>
        )}
        {live && count && <span className="shrink-0 text-vs-muted/70">· {count}</span>}
        <ChevronIcon className={`h-3 w-3 shrink-0 transition-transform ${open ? "rotate-90" : ""}`} />
      </button>
      {open && (trace || steps.length > 0) && (
        <div className="mt-1.5 space-y-2 border-l border-vs-border pl-3.5">
          {trace && (
            <p className="vs-scroll max-h-40 overflow-y-auto whitespace-pre-wrap break-words text-[12.5px] italic leading-5 text-vs-muted">
              {trace}
            </p>
          )}
          {steps.length > 0 && (
            <ol className="space-y-1">
              {steps.map((step, i) => {
                const now = live && i === steps.length - 1;
                return (
                  <li key={`${i}-${step.label}-${step.detail ?? ""}`} className="flex min-w-0 items-center gap-2 text-[12.5px] leading-5">
                    {now ? (
                      <span aria-label="In progress" className="pulse-dot h-1.5 w-1.5 shrink-0 rounded-full bg-vs-accent" />
                    ) : (
                      <CheckIcon aria-hidden className="h-3 w-3 shrink-0 text-vs-muted/70" />
                    )}
                    <span className={`shrink-0 ${now ? "text-vs-fg" : "text-vs-muted"}`}>{step.label}</span>
                    {step.detail && (
                      <span className="min-w-0 truncate font-mono text-[11.5px] text-vs-muted/80" title={step.detail}>{step.detail}</span>
                    )}
                  </li>
                );
              })}
            </ol>
          )}
        </div>
      )}
    </div>
  );
}

const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? "" : "s"}`;

function SystemLine({ text, waiting }: { text: string; waiting?: boolean }) {
  // A live wait is a soft pill that pulses; short run boundaries ("Finished in
  // 12.4s") are a quiet pill too; a long stderr dump is a wrapped, muted note
  // so it never blows out the panel width.
  if (waiting || (text.length <= 80 && !text.includes("\n"))) {
    return (
      <div className="flex justify-center px-1" role={waiting ? "status" : undefined}>
        <span className="inline-flex max-w-full items-center gap-2 rounded-full border border-vs-border bg-vs-panel/60 px-3 py-1 text-[11.5px] text-vs-muted">
          {waiting && <span className="pulse-dot h-1.5 w-1.5 shrink-0 rounded-full bg-vs-accent" />}
          <span className={`truncate ${waiting ? "shimmer-text" : ""}`}>{text}</span>
        </span>
      </div>
    );
  }
  return (
    <p className="whitespace-pre-wrap break-words [overflow-wrap:anywhere] rounded-md bg-vs-hover/50 px-3 py-2 font-mono text-[12px] leading-5 text-vs-muted">
      {text}
    </p>
  );
}

// ---------------------------------------------------------------------------
// Empty state & history
// ---------------------------------------------------------------------------

const EXAMPLES = [
  "Explain what this project does",
  "Review this project for bugs. Explain your findings before changing files.",
  "Suggest a small improvement and a step-by-step plan. Wait for my approval before editing.",
];

function EmptyState({
  ready,
  hasFiles,
  computerUnavailable,
  agentName,
  onExample,
}: {
  ready: boolean;
  hasFiles: boolean;
  computerUnavailable: boolean;
  agentName: string | null;
  onExample: (prompt: string) => void;
}) {
  const examples = hasFiles ? EXAMPLES.map((prompt, index) => ({ prompt, label: ["Understand this project", "Review potential bugs", "Plan an improvement"][index] })) : [
    { label: "Brainstorm an idea", prompt: "Help me brainstorm an idea. Ask me what I have in mind first." },
    { label: "Learn something new", prompt: "Help me understand a topic. Ask me what I would like to learn about." },
    { label: "Help me write", prompt: "Help me write something. Ask me what I am writing and who it is for." },
  ];
  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 p-6 text-center">
      <span className="flex h-9 w-9 items-center justify-center rounded-xl bg-vs-accent/10 text-vs-accent">
        <SparkleIcon className="h-[18px] w-[18px]" />
      </span>
      <div>
        <p className="text-sm font-medium text-vs-fg">
          {ready ? hasFiles ? "What would you like to build?" : "What would you like to talk about?" : computerUnavailable ? "Connect your computer to start chatting" : "Set up AI to start chatting"}
        </p>
        <p className="mt-1.5 max-w-sm text-xs leading-5 text-vs-muted">
          {ready
            ? hasFiles ? `${agentName} can explore this repository and help you make changes. Start with one clear task, then review the result in Changes.` : `Ask ${agentName} a question, brainstorm ideas, or get help writing. No files are needed. You can also ask AI to build something from scratch.`
            : computerUnavailable ? "Use the computer connection button above to get started. You can open your saved conversations and browse files while your computer is offline."
            : "Set up an AI tool on your computer, then choose it in the message box. Your saved conversations and files are available now."}
        </p>
      </div>
      {ready && (
        <div className="flex w-full max-w-sm flex-col gap-1.5">
          {examples.map((example) => (
            <button
              key={example.label}
              type="button"
              onClick={() => onExample(example.prompt)}
              className="rounded-lg border border-vs-border px-2.5 py-1.5 text-left text-xs text-vs-fg transition hover:border-vs-accent hover:bg-vs-hover"
            >
              {example.label}
            </button>
          ))}
          <p className="mt-1 text-[11px] leading-4 text-vs-muted">Choose a starter, edit your message, then Send. Selecting a starter does not run AI.</p>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Who is watching
// ---------------------------------------------------------------------------

/** The people currently in the room — "who is watching". */
function WatchingCluster({ members }: { members: SessionMember[] }) {
  const online = members.filter((member) => member.online);
  if (online.length === 0) return null;

  const shown = online.slice(0, 4);
  const extra = online.length - shown.length;

  return (
    <span className="flex items-center gap-1.5" title={`${online.length} watching this room`}>
      <EyeIcon className="h-3.5 w-3.5 text-vs-muted" />
      <span className="flex -space-x-1.5">
        {shown.map((member) => {
          const color = colorOf(member.userId);
          return (
            <span
              key={member.userId}
              title={member.displayName}
              className={`inline-flex h-5 w-5 items-center justify-center rounded-full text-[10px] font-semibold ring-2 ring-vs-panel ${color.chip}`}
            >
              {initialsOf(member.displayName)}
            </span>
          );
        })}
      </span>
      {extra > 0 && <span className="text-[11px] text-vs-muted">+{extra}</span>}
    </span>
  );
}

// ---------------------------------------------------------------------------
// Composer footer selectors
// ---------------------------------------------------------------------------

/** All composer selectors share the same upward-opening menu. */
function SelectChip({ icon, value, onChange, options, title }: {
  icon?: React.ReactNode;
  value: string;
  onChange: (value: string) => void;
  options: ComposerOption[];
  title: string;
}) {
  return <ComposerPicker label={title} icon={icon} value={value} options={options} onChange={onChange} />;
}

/** Signal-bar glyph for the capacity selector — no equivalent in the icon set. */
function BarsIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 16 16" fill="currentColor" aria-hidden className={className}>
      <rect x="1" y="10" width="2.5" height="5" rx="0.5" />
      <rect x="5" y="7" width="2.5" height="8" rx="0.5" />
      <rect x="9" y="4" width="2.5" height="11" rx="0.5" />
      <rect x="13" y="1" width="2.5" height="14" rx="0.5" opacity="0.4" />
    </svg>
  );
}

// ---------------------------------------------------------------------------
// Small shared pieces
// ---------------------------------------------------------------------------

/**
 * The command is shown to copy, never run for you: installing software on the
 * machine hosting this app is the operator's decision, not a button's.
 */
function CopyLine({ command }: { command: string }) {
  const [copied, setCopied] = useState(false);

  async function copy() {
    try {
      await navigator.clipboard.writeText(command);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      setCopied(false);
    }
  }

  return (
    <button
      type="button"
      onClick={copy}
      title="Copy"
      className="flex w-full items-center gap-1.5 rounded border border-vs-border bg-vs-panel px-2 py-1 text-left font-mono text-[11px] text-vs-fg transition hover:bg-vs-hover"
    >
      <span className="min-w-0 flex-1 truncate">{command}</span>
      {copied ? (
        <CheckIcon className="h-3 w-3 shrink-0 text-vs-success" />
      ) : (
        <span className="shrink-0 text-[10px] uppercase text-vs-muted">copy</span>
      )}
    </button>
  );
}

function StatusDot({ ok }: { ok: boolean }) {
  return (
    <span
      className={`h-1.5 w-1.5 shrink-0 rounded-full ${ok ? "bg-vs-success" : "bg-vs-muted"}`}
    />
  );
}

function Note({ children, tone }: { children: React.ReactNode; tone: "warn" }) {
  return (
    <p
      className={`flex items-start gap-2 border-b border-vs-border px-3 py-2 text-[12px] leading-5 text-vs-fg ${
        tone === "warn" ? "bg-vs-warn/10" : ""
      }`}
    >
      <AlertIcon className="mt-0.5 h-3.5 w-3.5 shrink-0 text-vs-warn" />
      {children}
    </p>
  );
}
