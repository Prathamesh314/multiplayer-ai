import { withApiLimit } from "../../../lib/http/api-limit";
import { query } from "../../../lib/db/client";
import { localRunnersEnabled } from "../../../lib/runner/jobs";
import { currentUser } from "../../../lib/auth/tokens";
import { AGENTS, type ModelInventory, type AgentStatus, type AgentsResponse } from "../../../lib/ai/catalog";
import { parallelChatsEnabled } from "../../../lib/ai/isolation";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Which agents this machine has, and whether it will run them.
 *
 * Those are two separate answers on purpose: detection is harmless and always
 * given, so the panel can show what is installed and offer install instructions
 * even on a server that refuses to execute anything.
 */
async function handleGET() {
  const user = await currentUser();
  if (!user) {
    return Response.json({ error: "Sign in to continue." }, { status: 401 });
  }

  // AI tools run only on members' own computers, so the tools that count are
  // the ones their connected runners report (refreshed by each heartbeat).
  const devices = localRunnersEnabled() ? await query<{ agent_ids: string[]; model_catalog: Record<string, ModelInventory> }>(
    `SELECT agent_ids, model_catalog FROM runner_devices WHERE user_id = $1 AND revoked_at IS NULL AND version = '2'
      AND last_seen_at > now() - interval '30 seconds'`, [user.id],
  ) : [];
  const localIds = new Set(devices.flatMap(device => device.agent_ids));
  const detected: AgentStatus[] = AGENTS.map(spec => ({
    id: spec.id, name: spec.name, vendor: spec.vendor, blurb: spec.blurb, installed: false, version: null, auth: null, install: spec.install,
  }));
  const agents = detected.map(agent => {
    const matching = devices.filter(device => device.agent_ids.includes(agent.id));
    if (!matching.length) return agent;
    const spec = AGENTS.find(spec => spec.id === agent.id)!;
    const inventories = matching.map(device => device.model_catalog?.[agent.id] ?? {
      choices: spec.requiresModel ? [] : [{ id: "", label: "Auto · update runner for model discovery", efforts: spec.efforts }],
      source: "Older runner", checkedAt: 0, refreshedAt: null, stale: true,
    });
    const choices = new Map<string, (typeof spec.models)[number]>();
    for (const inventory of inventories) for (const choice of inventory.choices) {
      const previous = choices.get(choice.id);
      choices.set(choice.id, { ...choice, efforts: [...new Map([...(previous?.efforts ?? []), ...(choice.efforts ?? [])].map(effort => [effort.id, effort])).values()] });
    }
    return { ...agent, installed: true, auth: null, execution: "runner" as const,
      models: { choices: [...choices.values()], source: "Your runner · " + [...new Set(inventories.map(item => item.source))].join(", "),
        checkedAt: Math.max(...inventories.map(item => item.checkedAt)), refreshedAt: Math.max(...inventories.map(item => item.refreshedAt ?? 0)) || null,
        stale: inventories.some(item => item.stale), error: inventories.some(item => item.stale) ? "Some runner inventories are unavailable or cached." : undefined } };
  });
  return Response.json(
    {
      agents,
      canRun: localIds.size > 0,
      reason: localIds.size > 0 ? null : "Connect your computer, then install and sign in to an AI tool on it.",
      parallelChats: parallelChatsEnabled(),
    } satisfies AgentsResponse,
    { headers: { "cache-control": "no-store" } },
  );
}

export const GET = withApiLimit("/api/ai/agents", handleGET);
