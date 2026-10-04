"use client";
import { openUserStream } from "../../lib/events/shared-client";

import { createPortal } from "react-dom";
import { Modal } from "../ui/Modal";
import { ComposerPicker } from "./ComposerPicker";
import { ModelPicker } from "./ModelPicker";

import { useEffect, useRef, useState } from "react";
import { agentById, type AgentAuth, type AgentChoice, type AgentStatus } from "../../lib/ai/catalog";
import {
  fetchAgents,
  fetchForkableRuns,
  fetchMentionTargets,
  loginAgent,
  logoutAgent,
  runAgent,
  type ForkableRun,
  type RunHandle,
} from "../../lib/ai/client";
import type { AgentRun } from "../../lib/ai/runs";
import { fetchRun } from "../../lib/ai/runs-client";
import { openSessionStream } from "../../lib/events/client";
import { colorOf, initialsOf } from "../../lib/people";
import type { SessionMember } from "../../lib/session/types";
import {
  AlertIcon,
  CheckIcon,
  CloseIcon,
  EyeIcon,
  GitBranchIcon,
  PlusIcon,
  SparkleIcon,
  SpinnerIcon,
  TerminalIcon,
} from "../icons";
import { QueuedMessages } from "./QueuedMessages";
import { Composer, type ComposerHandle, type MentionRoom, type MentionPerson } from "./chat";
import { WorkspaceHistory } from "./WorkspaceHistory";
import { HandoffPanel } from "./HandoffPanel";
import { TaskPanel } from "../tasks/TaskPanel";
import { isSelfAssignment, SELF_ASSIGNMENT_ERROR } from "../../lib/tasks/types";
import { Markdown } from "./Markdown";

type AiPanelProps = {
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
  repoId: string | null;
  onRepoChange: (repoId: string | null) => void;
  /** Open the folder picker to import a new repo into the room. */
  onImportRepo: () => void;
  importingRepo: boolean;
  /** Omitted when embedded as the center Chat tab, where there is no X to show. */
  onClose?: () => void;
};

/** One line of the conversation, whether streamed live or read from history. */
type Turn = {
  id: string;
  role: "user" | "agent" | "system";
  text: string;
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
};

export function AiPanel({
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
  repoId,
  onRepoChange,
  onImportRepo,
  importingRepo,
  onClose,
}: AiPanelProps) {
  const [assignOpen, setAssignOpen] = useState(false);
  const [planMode, setPlanMode] = useState(false);
  const composer = useRef<ComposerHandle>(null);
  const [taskRevision, setTaskRevision] = useState(0);
  const [taskRoster, setTaskRoster] = useState<{ sessionId: string; people: MentionPerson[] } | null>(null);
  const taskRequest = useRef<{ payload: string; id: string } | null>(null);
  const [agents, setAgents] = useState<AgentStatus[] | null>(null);
  const [serverCanRun, setServerCanRun] = useState(true);
  const [blockedReason, setBlockedReason] = useState<string | null>(null);
  const [connected, setConnected] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [installFor, setInstallFor] = useState<string | null>(null);
  // Sign-in / sign-out for the connected agent's own account. `authBusy` holds
  // the id being worked on; `authLog` is the login CLI's live output (the URL
  // to visit, progress); `showAccount` expands the account card once signed in.
  const [authBusy, setAuthBusy] = useState<string | null>(null);
  const [authLog, setAuthLog] = useState("");
  const [authError, setAuthError] = useState<string | null>(null);
  const [showAccount, setShowAccount] = useState(false);
  const authHandle = useRef<RunHandle | null>(null);
  // Composer selectors. Reset together with the provider, since the options do.
  const [model, setModel] = useState("");
  const [showProviders, setShowProviders] = useState(false);
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
    setError(null);
    liveTurnIdRef.current = null;
    const agentName = agents?.find((a) => a.id === target.agentId)?.name ?? target.agentId;
    setTurns([]);
    try {
      const { messages } = await fetchRun(sessionId, target.id);
      if (generation !== historyGeneration.current || enteredRef.current?.id !== target.id) return;
      setTurns(
        messages
          // Every stored turn shows — replies, notices, warnings, errors, the
          // changed-files record. The old blanket drop of system turns on
          // completed runs guarded against a stderr transcript being stored on
          // success; the server no longer stores stderr except on failure,
          // where it is exactly the thing to show.
          .map((message) => {
            // "tool" turns are the agent's own machinery; show them as agent output.
            const role: Turn["role"] =
              message.role === "user" ? "user" : message.role === "system" ? "system" : "agent";
            return {
              id: uid(),
              role,
              text: message.body,
              activities: message.role === "tool" ? [message.body] : undefined,
              author: message.authorName ?? null,
              agentName: role === "agent" ? agentName : null,
            };
          }),
      );
    } catch {
      if (generation !== historyGeneration.current) return;
      setError("Could not load that run.");
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
            { id: uid(), role: "user", text: event.body, author: event.authorName ?? "Prompt" },
          ]);
        }
      },
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
    const refresh = () => { void fetchAgents().then((response) => {
      if (cancelled) return;
      setAgents(response.agents);
      setServerCanRun(response.canRun);
      setBlockedReason(response.reason);
      // Pre-select a ready agent, so the common case is one click. Codex is the
      // default when it is installed; otherwise the first installed one.
      setConnected((previous) => {
        if (previous) return previous;
        const installed = response.agents.filter((a) => a.installed);
        const codex = installed.find((a) => a.id === "codex");
        return codex?.id ?? installed[0]?.id ?? null;
      });
    }).catch(() => {}); };
    const stream = openUserStream(type => { if (type === "devices.changed") refresh(); }, refresh);
    window.addEventListener("focus", refresh);
    return () => {
      cancelled = true;
      stream.close();
      window.removeEventListener("focus", refresh);
    };
  }, []);

  // Follow the conversation as it grows.
  useEffect(() => {
    const element = scroller.current;
    if (element) element.scrollTop = element.scrollHeight;
  }, [turns]);

  async function recheck() {
    setRefreshing(true);
    try {
      const response = await fetchAgents(true);
      setAgents(response.agents);
      setServerCanRun(response.canRun);
      setBlockedReason(response.reason);
    } catch { setError("Could not refresh providers. Your previous choices are preserved."); }
    finally { setRefreshing(false); }
  }

  // Switching provider clears the model/effort picks, whose options differ per agent.
  function selectProvider(id: string) {
    setConnected(id);
    setModel("");
    setEffort("");
    setInstallFor(null);
    setShowAccount(false);
    setAuthError(null);
  }

  /** Replace one agent's cached login state after a sign-in / sign-out. */
  function patchAuth(agentId: string, auth: AgentAuth | null) {
    setAgents((prev) => prev?.map((a) => (a.id === agentId ? { ...a, auth } : a)) ?? prev);
  }

  /**
   * Start the agent's own browser sign-in. The CLI opens the OAuth page and we
   * stream its output; on exit it reports the fresh login state, which flips the
   * panel to ready. The app never sees the token — the CLI stores it itself.
   */
  function signIn(agentId: string) {
    if (authBusy) return;
    setAuthBusy(agentId);
    setAuthLog("");
    setAuthError(null);
    setShowAccount(true);
    authHandle.current = loginAgent(agentId, {
      onEvent: (event) => {
        if (event.t === "out" || event.t === "err") {
          setAuthLog((prev) => (prev + event.d).slice(-4000));
        } else if (event.t === "exit") {
          patchAuth(agentId, event.auth);
          if (!event.auth?.loggedIn) {
            setAuthError("Sign-in did not complete. Try again.");
          }
        }
      },
      onError: setAuthError,
      onDone: () => setAuthBusy(null),
    });
  }

  async function signOut(agentId: string) {
    if (authBusy) return;
    setAuthBusy(agentId);
    setAuthError(null);
    try {
      const auth = await logoutAgent(agentId);
      patchAuth(agentId, auth);
      setShowAccount(false);
    } catch (cause) {
      setAuthError(cause instanceof Error ? cause.message : "Could not sign out.");
    } finally {
      setAuthBusy(null);
    }
  }

  function ask(prompt: string, contextRefs?: string[]) {
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
    const userTurn: Turn = { id: uid(), role: "user", text: prompt, author: "You" };
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
      },
      {
        onEvent: (event) => {
          if (event.t === "start") {
            localRunIdRef.current = event.runId; // so the room broadcast of our own run is ignored
            setTurns((prev) => [
              ...prev,
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
            setTurns((prev) => [...prev, { id: uid(), role: "system", text: event.message }]);
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
  const activeAuth = active?.auth ?? null;
  // An installed agent whose CLI has its own login must be signed in before it
  // can run — otherwise a run would just fail with an auth error.
  const authCapable = !!active?.installed && !!activeAuth;
  const needsLogin = authCapable && !activeAuth!.loggedIn;
  const ready = !!active?.installed && serverCanRun && canRun && !needsLogin;
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
  // row: choosing it opens the folder picker instead of selecting anything.
  const repoChoices: AgentChoice[] = [
    ...repoOptions,
    { id: "__import__", label: importingRepo ? "Importing…" : "Import new project…" },
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
        {authCapable && activeAuth?.loggedIn && (
          <>
            <span className="mx-0.5 h-3.5 w-px bg-vs-border" />
            <button
              type="button"
              onClick={() => setShowAccount((shown) => !shown)}
              title={`Signed in as ${activeAuth.email ?? "your account"}${
                activeAuth.plan ? ` · ${planLabel(activeAuth.plan)}` : ""
              } — click to manage`}
              className="composer-control"
            >
              <StatusDot ok />
              <span className="max-w-[6rem] truncate">
                {activeAuth.plan ? planLabel(activeAuth.plan) : "Account"}
              </span>
            </button>
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
  const chatTitle = entered?.title ?? (entered ? "Agent run" : "New chat");
  const repoLabel = enteredRepoLabel ?? repoOptions.find(option => option.id === (entered ? entered.repoId ?? "" : repoId ?? ""))?.label;
  const executionLabel = active?.execution === "runner" ? "Paired computer" : "App’s machine";
  const executionDetail = active?.execution === "runner"
    ? "Tasks run in local worktrees on your paired computer, using its tools and AI account."
    : "Tasks run on the machine hosting this app. Connect your computer to use its local worktrees instead.";

  return (
    <aside className="flex h-full min-h-0 w-full flex-col bg-vs-editor">
      <header className={`ai-chat-header flex min-w-0 shrink-0 items-center gap-3 ${entered ? "" : "border-b border-vs-border"}`}>
        <div className="min-w-0 flex-1">
          <h2 className="truncate text-base font-semibold text-vs-fg" title={chatTitle}>{chatTitle}</h2>
          <div className="mt-1 flex min-w-0 items-center gap-2 text-xs text-vs-muted">
            {repoLabel && <span className="flex min-w-0 items-center gap-1.5" title={repoLabel}><GitBranchIcon className="h-3 w-3 shrink-0" /><span className="truncate">{repoLabel}</span></span>}
            {repoLabel && active?.installed && <span aria-hidden="true">·</span>}
            {active?.installed && <span className="flex shrink-0 items-center gap-1.5" title={executionDetail}><TerminalIcon className="h-3 w-3" />{executionLabel}</span>}
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-1">
        {entered &&
          (enteredIsMine ? (
            <button
              type="button"
              onClick={onNewRun}
              className="flex items-center gap-1 rounded-md px-2 py-1.5 text-xs text-vs-muted transition hover:bg-vs-hover hover:text-vs-fg"
            >
              <PlusIcon className="h-3 w-3" />
              New
            </button>
          ) : (
            <button
              type="button"
              onClick={() => onForkEntered(entered)}
              title={`Fork ${entered.startedByName}'s chat: a new chat that imports its context`}
              className="flex items-center gap-1 rounded-md px-2 py-1.5 text-xs text-vs-muted transition hover:bg-vs-hover hover:text-vs-fg"
            >
              <GitBranchIcon className="h-3 w-3" />
              Copy chat
            </button>
          ))}
        <button type="button" onClick={() => setShowProviders(previous => !previous)} aria-expanded={showProviders} className="rounded px-2 py-1 text-xs text-vs-muted hover:bg-vs-hover">Providers</button>
        <span className="ml-1 hidden sm:inline-flex"><WatchingCluster members={members} /></span>
        {onClose && <button type="button" onClick={onClose} aria-label="Close AI chat" className="rounded-md p-1.5 text-vs-muted hover:bg-vs-hover hover:text-vs-fg"><CloseIcon className="h-3.5 w-3.5" /></button>}
        </div>
      </header>
      {actionsHost && createPortal(<>
        <button type="button" disabled={!canRun} onClick={() => setAssignOpen(true)} className="rounded px-2 py-1.5 text-xs text-vs-muted hover:bg-vs-hover disabled:opacity-40">Assign Tasks</button>
        {entered ? <HandoffPanel key={`handoff-${entered.id}`} compact run={entered} userId={myId} canEdit={canRun} isOwner={isOwner} onUpdated={updated => onEntered?.(updated)} /> : <button type="button" disabled title="Start a chat before handing it off" className="rounded px-2 py-1.5 text-xs text-vs-muted opacity-40">Handoff</button>}
        <button type="button" disabled={!ready || running || !!entered && (!enteredIsMine || ["running", "queued"].includes(entered.status))} title="Draft a review request in the conversation" onClick={() => { onShowConversation?.(); composer.current?.insertPrompt("Review the changes in this repository for bugs and regressions. Explain your findings with file references before changing any files."); }} className="flex items-center gap-1 rounded px-2 py-1.5 text-xs text-vs-accent hover:bg-vs-hover disabled:opacity-40"><EyeIcon className="h-3 w-3" />Review</button>
      </>, actionsHost)}
      {assignOpen && <Modal title="Assign Tasks" description="Type @ and choose a teammate, then describe the task." onClose={() => setAssignOpen(false)}>
        <Composer key={entered?.id ?? "new"} placeholder="@teammate Describe the task…" disabled onSend={() => {}} people={taskPeople} onAssignTask={assignChatTask} narrow />
        {taskPeople.length === 0 && <p className="text-sm text-vs-muted">No teammates are available to assign. Invite a teammate to this room first.</p>}
      </Modal>}
      {entered && <div className="px-4 py-1 text-xs text-vs-muted"><WorkspaceHistory key={`history-${entered.id}`} run={entered} userId={myId} /></div>}

      {/* Once an agent is ready the provider/model/capacity live in the composer
          footer; the full selector is only for connecting or installing one. */}
      {(!ready || showProviders) && (
        <>
        {active?.installed && <p className="px-4 py-2 text-xs leading-5 text-vs-muted">{executionDetail}</p>}
        <AgentSelector
          agents={agents}
          connected={connected}
          installFor={installFor}
          refreshing={refreshing}
          onSelect={selectProvider}
          onToggleInstall={(id) => setInstallFor((shown) => (shown === id ? null : id))}
          onRecheck={recheck}
        />
        </>
      )}

      {!serverCanRun && blockedReason && (
        <Note tone="warn">Agents are detected but will not run here. {blockedReason}</Note>
      )}
      {serverCanRun && !canRun && (
        <Note tone="warn">You have read access here, and running an agent edits files.</Note>
      )}

      {active && authCapable && (needsLogin || showAccount || authBusy === active.id) && (
        <ConnectionCard
          agentName={active.name}
          auth={activeAuth}
          busy={authBusy === active.id}
          log={authLog}
          error={authError}
          onSignIn={() => signIn(active.id)}
          onSignOut={() => signOut(active.id)}
          onCancel={() => authHandle.current?.cancel()}
          onDismiss={() => setShowAccount(false)}
        />
      )}

      <div ref={scroller} className="vs-scroll min-h-0 flex-1 overflow-y-auto overflow-x-hidden">
        {hasConversation ? (
          <Conversation turns={turns} />
        ) : (
          <EmptyState
            ready={ready}
            agentName={active?.name ?? null}
            onExample={prompt => composer.current?.insertPrompt(prompt)}
          />
        )}
        {error && (
          <p className="mx-3 mb-3 flex items-start gap-2 rounded-md border border-vs-danger/40 bg-vs-danger/10 px-3 py-2 text-[12px] leading-5 text-vs-danger">
            <AlertIcon className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            {error}
          </p>
        )}
        {entered && myUserId && <div className="mx-auto max-w-4xl px-3"><TaskPanel key={entered.id} userId={myUserId} sessionId={sessionId} runId={entered.id} canAssign={canRun} showAssignAction={false} hideWhenEmpty refreshVersion={taskRevision} /></div>}
      </div>

      {ready && (!modelAvailable || !effortAvailable) && <p role="status" className="border-t border-vs-border px-3 py-2 text-xs text-vs-warn">Choose an available model{!effortAvailable ? " and effort" : ""}. The previous selection will not be replaced automatically.</p>}
      {running ? (
        <div className="flex shrink-0 items-center gap-2 border-t border-vs-border bg-vs-panel p-2.5 text-sm text-vs-muted">
          <SpinnerIcon className="h-3.5 w-3.5 text-vs-accent" />
          <span className="text-vs-fg">{active?.name ?? "Agent"} is working…</span>
          <button
            type="button"
            onClick={() => run.current?.cancel()}
            className="ml-auto rounded border border-vs-border px-2 py-0.5 text-[12px] transition hover:bg-vs-hover hover:text-vs-fg"
          >
            Detach
          </button>
        </div>
      ) : entered && !enteredIsMine ? (
        <>
        <div className="border-t border-vs-border p-3 text-sm text-vs-muted">You’re watching {entered.driverName}’s chat. Accept a handoff to continue here, or <button className="text-vs-accent underline" onClick={() => onForkEntered(entered)}>fork a new chat</button>.</div>
        </>
      ) : entered && ["running", "queued"].includes(entered.status) ? (
        <div className="border-t border-vs-border p-3 text-sm text-vs-muted">The agent is working. You can queue another instruction below.</div>
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
            !ready
              ? "Connect an agent to start a conversation…"
              : entered && !enteredIsMine
                ? `Fork ${entered.startedByName}'s session with ${active!.name}…`
                : `Message ${active!.name}…${mentionRooms.length > 0 ? "  (@ chat references)" : ""}`
          }
          onSend={ask}
        />
      )}
      {entered && <QueuedMessages key={`queue-${entered.id}`} sessionId={sessionId} runId={entered.id} version={entered.controlVersion} active={running || ["running", "queued"].includes(entered.status)} canSend={!!enteredIsMine && canRun} agentId={entered.agentId} startedAt={entered.startedAt} moveDraft={text => composer.current?.insertPrompt(text)} />}
    </aside>
  );
}

// ---------------------------------------------------------------------------
// Agent selector
// ---------------------------------------------------------------------------

function AgentSelector({
  agents,
  connected,
  installFor,
  refreshing,
  onSelect,
  onToggleInstall,
  onRecheck,
}: {
  agents: AgentStatus[] | null;
  connected: string | null;
  installFor: string | null;
  refreshing: boolean;
  onSelect: (id: string) => void;
  onToggleInstall: (id: string) => void;
  onRecheck: () => void;
}) {
  const detail = agents?.find((agent) => agent.id === installFor);

  return (
    <div className="shrink-0 border-b border-vs-border px-2 py-2">
      <div className="mb-1.5 flex items-center justify-between px-1">
        <span className="text-[11px] font-semibold uppercase tracking-wider text-vs-muted">Agent</span>
        <button
          type="button"
          onClick={onRecheck}
          disabled={refreshing}
          className="text-[13px] text-vs-muted transition hover:text-vs-fg disabled:opacity-50"
        >
          {refreshing ? "Checking…" : "Recheck"}
        </button>
      </div>

      {agents === null ? (
        <p className="flex items-center gap-2 px-1 py-1.5 text-sm text-vs-muted">
          <SpinnerIcon className="h-3.5 w-3.5" />
          Looking for installed agents…
        </p>
      ) : (
        <div className="flex flex-col gap-1">
          {agents.map((agent) => {
            const selected = connected === agent.id;
            return (
              <button
                key={agent.id}
                type="button"
                onClick={() => (agent.installed ? onSelect(agent.id) : onToggleInstall(agent.id))}
                className={`group flex items-center gap-2.5 rounded-lg border px-2.5 py-2 text-left transition ${
                  selected
                    ? "border-vs-accent bg-vs-accent/10"
                    : "border-transparent hover:border-vs-border hover:bg-vs-hover"
                }`}
              >
                <span
                  className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-md ${
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
                  <span className="block truncate text-[11px] text-vs-muted">
                    {agentSubtitle(agent)}
                  </span>
                </span>
                {agent.installed ? (
                  selected ? (
                    agent.auth && !agent.auth.loggedIn ? (
                      <span className="shrink-0 text-[11px] font-medium uppercase tracking-wide text-vs-accent">
                        Sign in
                      </span>
                    ) : (
                      <span className="flex shrink-0 items-center gap-1 text-[11px] font-medium text-vs-accent">
                        <CheckIcon className="h-3 w-3" />
                        Connected
                      </span>
                    )
                  ) : (
                    <span className="shrink-0 text-[11px] text-vs-muted opacity-0 transition group-hover:opacity-100">
                      Select
                    </span>
                  )
                ) : (
                  <span className="shrink-0 text-[11px] uppercase tracking-wide text-vs-accent">
                    {installFor === agent.id ? "Hide" : "Install"}
                  </span>
                )}
              </button>
            );
          })}
        </div>
      )}

      {detail && !detail.installed && (
        <div className="mt-1.5 space-y-1.5 rounded-lg border border-vs-border bg-vs-editor p-2">
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

/** First http(s) URL in the login CLI's output, for a manual "open" fallback. */
function firstUrl(text: string): string | null {
  return text.match(/https?:\/\/[^\s'"]+/)?.[0] ?? null;
}

/**
 * Sign in to / out of an agent's own account.
 *
 * The whole point of this — like Conductor — is to run on the operator's own
 * Pro/Max subscription rather than metered API billing. Sign-in opens the
 * CLI's browser OAuth flow; the token stays with the CLI, never this app.
 */
function ConnectionCard({
  agentName,
  auth,
  busy,
  log,
  error,
  onSignIn,
  onSignOut,
  onCancel,
  onDismiss,
}: {
  agentName: string;
  auth: AgentAuth | null;
  busy: boolean;
  log: string;
  error: string | null;
  onSignIn: () => void;
  onSignOut: () => void;
  onCancel: () => void;
  onDismiss: () => void;
}) {
  const loggedIn = !!auth?.loggedIn;
  const url = busy ? firstUrl(log) : null;

  return (
    <div className="shrink-0 space-y-2 border-b border-vs-border bg-vs-editor px-3 py-2.5">
      <div className="flex items-center justify-between">
        <span className="text-[11px] font-semibold uppercase tracking-wider text-vs-muted">
          {agentName} account
        </span>
        {loggedIn && !busy && (
          <button
            type="button"
            onClick={onDismiss}
            className="text-[13px] text-vs-muted transition hover:text-vs-fg"
          >
            Hide
          </button>
        )}
      </div>

      {busy ? (
        <div className="space-y-2">
          <p className="flex items-center gap-2 text-[12px] text-vs-fg">
            <SpinnerIcon className="h-3.5 w-3.5 text-vs-accent" />
            Signing in… complete it in the browser window that opened.
          </p>
          {url && (
            <a
              href={url}
              target="_blank"
              rel="noreferrer"
              className="block truncate text-[12px] text-vs-accent underline-offset-2 hover:underline"
            >
              Open the sign-in page ↗
            </a>
          )}
          {log.trim() && (
            <pre className="vs-scroll max-h-24 overflow-auto whitespace-pre-wrap break-words rounded border border-vs-border bg-vs-panel p-2 font-mono text-[11px] leading-4 text-vs-muted">
              {log.trim()}
            </pre>
          )}
          <button
            type="button"
            onClick={onCancel}
            className="rounded border border-vs-border px-2 py-0.5 text-[12px] text-vs-fg transition hover:bg-vs-hover"
          >
            Cancel
          </button>
        </div>
      ) : loggedIn ? (
        <div className="flex items-center gap-2">
          <StatusDot ok />
          <span className="min-w-0 flex-1 text-[12px] leading-4 text-vs-fg">
            Signed in as <span className="font-medium">{auth?.email ?? "your account"}</span>
            {auth?.plan && (
              <span className="ml-1.5 rounded bg-vs-accent/15 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-vs-accent">
                {planLabel(auth.plan)}
              </span>
            )}
          </span>
          <button
            type="button"
            onClick={onSignOut}
            className="shrink-0 rounded border border-vs-border px-2 py-0.5 text-[12px] text-vs-fg transition hover:bg-vs-hover"
          >
            Sign out
          </button>
        </div>
      ) : (
        <div className="space-y-2">
          <p className="text-[12px] leading-4 text-vs-muted">
            Sign in with your {agentName} subscription to run agents on your existing plan — no API
            key, no per-token billing. Sign-in opens in your browser; the token stays with the CLI.
          </p>
          <button
            type="button"
            onClick={onSignIn}
            className="flex items-center gap-1.5 rounded-md bg-vs-accent px-2.5 py-1.5 text-[12px] font-medium text-vs-accent-fg transition hover:opacity-90"
          >
            <SparkleIcon className="h-3.5 w-3.5" />
            Sign in with {agentName}
          </button>
        </div>
      )}

      {error && (
        <p className="flex items-start gap-1.5 text-[12px] leading-4 text-vs-danger">
          <AlertIcon className="mt-0.5 h-3 w-3 shrink-0" />
          {error}
        </p>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Conversation
// ---------------------------------------------------------------------------

function Conversation({ turns }: { turns: Turn[] }) {
  // Agent/system turns carry CLI framing (Codex's banner, model-manager error
  // logs, its echo of the prompt, the token tally). Strip it to the reply;
  // a turn that was nothing but noise is dropped entirely.
  const visible = turns.flatMap((turn) => {
    if (turn.role === "user") return [turn];
    // A still-streaming agent turn is kept even when empty — it renders the
    // "Thinking…" placeholder until stdout arrives.
    if (turn.streaming) return [turn];
    const text = cleanRunText(turn.text);
    return text ? [{ ...turn, text }] : [];
  });

  return (
    <div className="conversation-transcript mx-auto flex w-full max-w-4xl flex-col gap-6 px-8 py-5">
      <details className="text-sm text-vs-muted"><summary className="cursor-pointer">{turns.reduce((count, turn) => count + (turn.activities?.length ?? 0), 0)} tool calls · {visible.filter(turn => turn.role !== "system").length} messages</summary><p className="mt-2 text-xs">Tool calls reflect available activity in this conversation. Expand a response’s steps to inspect them.</p></details>
      {visible.map((turn) =>
        turn.role === "system" ? (
          <SystemLine key={turn.id} text={turn.text} />
        ) : (
          <TurnBubble key={turn.id} turn={turn} />
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

function TurnBubble({ turn }: { turn: Turn }) {
  // The user's own prompts sit on the right as a bubble; the agent replies on
  // the left as rendered Markdown — the familiar assistant-chat layout.
  if (turn.role === "user") {
    const author = turn.author ?? "You";
    return (
      <div className="flex flex-col items-end gap-1">
        {author !== "You" && <span className="pr-1 text-[12px] text-vs-muted">{author}</span>}
        <div className="human-message max-w-[92%] whitespace-pre-wrap break-words rounded-md px-4 py-3 text-[14px] leading-[1.6] text-vs-fg">
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
          {turn.streaming && <SpinnerIcon className="h-3 w-3 shrink-0 text-vs-muted" />}
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
          hasTrace ? null : <p className="text-[15px] leading-6 text-vs-muted">Thinking…</p>
        ) : (
          <Markdown text={turn.text} />
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
 * The live "it's working" trace: the reasoning stream plus each tool step as it
 * happens. Expanded while the agent is still thinking (no answer yet), then
 * auto-collapses to a toggle once the reply starts — the answer is the point,
 * the trace is there if you want to see how it got there.
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
  // Follow `live` by default — expanded while working, folded once the answer
  // starts — until the user makes an explicit choice, which then sticks.
  const [userOpen, setUserOpen] = useState<boolean | null>(null);
  const open = userOpen ?? live;

  const steps = activities ?? [];
  const trace = thinking?.trim() ?? "";

  return (
    <div className="mb-3 text-vs-muted">
      <button
        type="button"
        onClick={() => setUserOpen(!open)}
        className="flex w-full items-center gap-1.5 px-2 py-1 text-[13px] text-vs-muted transition hover:text-vs-fg"
      >
        {live ? (
          <SpinnerIcon className="h-3 w-3 text-vs-accent" />
        ) : (
          <SparkleIcon className="h-3 w-3 text-vs-muted" />
        )}
        <span>{live ? "Working" : "Thought & steps"}</span>
        {steps.length > 0 && <span className="text-vs-muted/70">· {steps.length} tool calls</span>}
        <span className="ml-auto">{open ? "▾" : "▸"}</span>
      </button>
      {open && (
        <div className="space-y-1.5 border-t border-vs-border px-2 py-1.5">
          {trace && (
            <p className="vs-scroll max-h-40 overflow-y-auto whitespace-pre-wrap break-words text-[12px] italic leading-5 text-vs-muted">
              {trace}
            </p>
          )}
          {steps.length > 0 && (
            <ul className="space-y-0.5">
              {steps.map((step, i) => (
                <li
                  key={`${i}-${step}`}
                  className="flex items-center gap-1.5 font-mono text-[11.5px] leading-4 text-vs-fg"
                >
                  <span className="h-1 w-1 shrink-0 rounded-full bg-vs-accent" />
                  <span className="truncate">{step}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}

function SystemLine({ text }: { text: string }) {
  // Short run boundaries read as a centered divider; a long stderr dump is shown
  // as a wrapped, muted note so it never blows out the panel width.
  if (text.length <= 52 && !text.includes("\n")) {
    return (
      <div className="flex items-center gap-2 px-1">
        <span className="h-px flex-1 bg-vs-border" />
        <span className="shrink-0 text-[11px] text-vs-muted">{text}</span>
        <span className="h-px flex-1 bg-vs-border" />
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
  agentName,
  onExample,
}: {
  ready: boolean;
  agentName: string | null;
  onExample: (prompt: string) => void;
}) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-4 p-6 text-center">
      <span className="flex h-12 w-12 items-center justify-center rounded-2xl bg-vs-accent/10 text-vs-accent">
        <SparkleIcon className="h-6 w-6" />
      </span>
      <div>
        <p className="text-base font-medium text-vs-fg">
          {ready ? "What would you like to build?" : "Choose an AI to get started"}
        </p>
        <p className="mt-2 max-w-sm text-sm leading-6 text-vs-muted">
          {ready
            ? `${agentName} can explore this repository and help you make changes. Start with one clear task, then review the result in Changes.`
            : "Choose a provider above, or open Room guide for setup help. You can browse the files without connecting AI."}
        </p>
      </div>
      {ready && (
        <div className="flex w-full max-w-sm flex-col gap-2">
          {EXAMPLES.map((example) => (
            <button
              key={example}
              type="button"
              onClick={() => onExample(example)}
              className="rounded-lg border border-vs-border px-3 py-2 text-left text-sm text-vs-fg transition hover:border-vs-accent hover:bg-vs-hover"
            >
              {example === EXAMPLES[0] ? "Understand this project" : example === EXAMPLES[1] ? "Review potential bugs" : "Plan an improvement"}
            </button>
          ))}
          <p className="mt-1 text-xs leading-5 text-vs-muted">Choose a starter, edit your message, then Send. Selecting a starter does not run AI.</p>
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
  options: AgentChoice[];
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
