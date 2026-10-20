import { agentById, type AgentStatus } from "./catalog";

/*
 * The composer's agent, model and effort, remembered on this device so a
 * reload keeps what the member picked. Browser storage can be unavailable
 * (private windows, blocked site data); then the defaults apply as before.
 */

type Choice = { agent?: string; picks?: Record<string, { model?: string; effort?: string }> };
const KEY = "multicode.composer.v1";

function read(): Choice {
  try {
    const value = JSON.parse(window.localStorage.getItem(KEY) ?? "{}") as Choice;
    return value && typeof value === "object" && !Array.isArray(value) ? value : {};
  } catch {
    return {};
  }
}

/**
 * Saves this agent's model and effort. `asDefault` also makes it the agent new
 * chats start with; following an opened chat's agent does not, so looking at
 * a Claude chat doesn't change what a new chat uses.
 */
export function rememberChoice(agent: string, model: string, effort: string, asDefault = true) {
  try {
    const choice = read();
    window.localStorage.setItem(KEY, JSON.stringify({ agent: asDefault ? agent : choice.agent, picks: { ...choice.picks, [agent]: { model, effort } } }));
  } catch {
    // Not remembered; nothing else depends on it.
  }
}

/** The member's last agent when it is still ready here; otherwise Codex, then the first installed one. */
export function preferredAgent(agents: AgentStatus[]): string | null {
  const installed = agents.filter((agent) => agent.installed);
  const saved = read().agent;
  return installed.find((agent) => agent.id === saved)?.id ?? installed.find((agent) => agent.id === "codex")?.id ?? installed[0]?.id ?? null;
}

/**
 * The agent a composer starts with: the one that ran the opened chat when it is
 * ready here, so a follow-up continues with the same tool; otherwise (and for
 * a new chat) the member's usual one.
 */
export function agentForChat(agents: AgentStatus[], chatAgent: string | null | undefined): string | null {
  if (chatAgent && agents.some((agent) => agent.installed && agent.id === chatAgent)) return chatAgent;
  return preferredAgent(agents);
}

/** The model and effort last used with this agent, when it still offers them. */
export function savedPicks(agent: AgentStatus | undefined): { model: string; effort: string } {
  const pick = agent ? read().picks?.[agent.id] : undefined;
  const choice = pick?.model !== undefined ? agent?.models?.choices.find((item) => item.id === pick.model) : undefined;
  if (!pick || !choice) return { model: "", effort: "" };
  const efforts = choice.efforts ?? agentById(agent!.id)?.efforts ?? [];
  const effort = pick.effort && efforts.some((item) => item.id === pick.effort) ? pick.effort : "";
  return { model: choice.id, effort };
}
