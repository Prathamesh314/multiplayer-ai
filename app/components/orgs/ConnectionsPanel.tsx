"use client";
import { AgentToolsPanel } from "../ai/AgentToolsPanel";
import { useCallback, useEffect, useRef, useState } from "react";
import type { Org } from "../../lib/org/types";
import type { Project } from "../../lib/project/types";
import type { SourceChannel, TeamProvider } from "../../lib/integrations/types";
import { desktopBridge } from "../../lib/desktop";
import { FolderIcon, LinkIcon, SpinnerIcon } from "../icons";
import { ComposerPicker } from "../workspace/ComposerPicker";
import {
  ErrorNote,
  GhostButton,
  Modal,
  PrimaryButton,
  inputClass,
} from "../ui/Modal";
type SavedChannel = SourceChannel & {
  verifiedAt: string | null;
  syncedAt: string | null;
  error: string | null;
  messageCount: number;
};
type Summary = {
  canManage: boolean;
  providers: { id: TeamProvider; configured: boolean }[];
  connections: {
    id: string;
    provider: TeamProvider;
    name: string;
    channels: SavedChannel[];
  }[];
};
const names = { slack: "Slack", discord: "Discord" };
type DiscordServer = { id: string; name: string; access: "ready" | "install" | "ask" };
async function api<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, {
    ...init,
    headers: { "content-type": "application/json", ...init?.headers },
  });
  const data = await response.json();
  if (!response.ok)
    throw new Error(data.error ?? "Could not complete this request.");
  return data;
}
export function ConnectionsPanel({
  org,
  projects,
  selectedId,
  onSelect,
  chooseDiscord = false,
  onDiscordChosen,
}: {
  org: Org;
  projects: Project[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  /** Open the Discord server list on arrival, after signing in with Discord. */
  chooseDiscord?: boolean;
  onDiscordChosen?: () => void;
}) {
  const project = projects.find((p) => p.id === selectedId) ?? projects[0];
  return (
    <main className="app-page vs-scroll min-h-0 min-w-0 flex-1 overflow-y-auto">
      <div className="mx-auto max-w-4xl px-5 py-8 sm:px-8 lg:py-10">
        <p className="text-[11px] font-medium uppercase tracking-[0.18em] text-vs-muted">
          Project context
        </p>
        <h1 className="font-display mt-2 text-xl font-semibold tracking-tight">
          Bring your conversations along
        </h1>
        <p className="mt-2 max-w-2xl text-xs leading-5 text-vs-muted">
          Keep talking where your team already works. Connect selected Slack or
          Discord channels so AI can refer to your discussions and link back to
          the source, and give the agents MCP servers and plugins.
        </p>
        <div className="mt-5 max-w-sm">
          <p className="text-sm font-medium text-vs-muted">Project</p>
          <div className="mt-1.5">
            <ComposerPicker
              label="Project for connections"
              value={project?.id ?? ""}
              onChange={onSelect}
              options={projects.length
                ? projects.map((item) => ({ id: item.id, label: item.name }))
                : [{ id: "", label: "No projects available" }]}
              icon={<FolderIcon className="h-4 w-4 shrink-0 text-vs-muted" />}
              variant="field"
              disabled={!projects.length}
            />
          </div>
        </div>
        {project ? (
          <>
            <ProjectConnections
              key={project.id}
              orgSlug={org.slug}
              project={project}
              chooseDiscord={chooseDiscord}
              onDiscordChosen={onDiscordChosen}
            />
            <div className="mt-8 border-t border-vs-border pt-6">
              <AgentToolsPanel
                key={`tools-${project.id}`}
                scope="project"
                base={`/api/orgs/${encodeURIComponent(org.slug)}/projects/${encodeURIComponent(project.slug)}/agent-tools`}
                projectName={project.name}
              />
            </div>
          </>
        ) : (
          <p className="mt-6 text-xs text-vs-muted">
            Create or join a project to connect its channels.
          </p>
        )}
      </div>
    </main>
  );
}
function ProjectConnections({
  orgSlug,
  project,
  chooseDiscord,
  onDiscordChosen,
}: {
  orgSlug: string;
  project: Project;
  chooseDiscord?: boolean;
  onDiscordChosen?: () => void;
}) {
  const base = `/api/orgs/${encodeURIComponent(orgSlug)}/projects/${encodeURIComponent(project.slug)}/integrations`;
  const [data, setData] = useState<Summary | null>(null),
    [error, setError] = useState<string | null>(null),
    [busy, setBusy] = useState<string | null>(null);
  const [checkedAt, setCheckedAt] = useState(0);
  const [browserProvider, setBrowserProvider] = useState<TeamProvider | null>(null);
  const [picker, setPicker] = useState<{
    provider: TeamProvider;
    channels: SourceChannel[];
    selected: string[];
    /** Only channels everyone can read: an older connection, made before members were recorded. */
    publicOnly?: boolean;
  } | null>(null);
  const [servers, setServers] = useState<DiscordServer[] | null>(null),
    [serverSearch, setServerSearch] = useState(""),
    [invite, setInvite] = useState<{ server: string; url: string; copied: boolean } | null>(null);
  const [disconnect, setDisconnect] = useState<TeamProvider | null>(null),
    [shared, setShared] = useState(false),
    [search, setSearch] = useState("");
  const reload = useCallback(async () => {
    const response = await api<Summary>(base);
    setData(response);
    setCheckedAt(Date.now());
  }, [base]);
  useEffect(() => {
    let alive = true;
    void api<Summary>(base)
      .then((value) => {
        if (alive) {
          setData(value);
          setCheckedAt(Date.now());
        }
      })
      .catch((cause) => {
        if (alive) setError(cause.message);
      });
    return () => {
      alive = false;
    };
  }, [base]);
  async function action(key: string, work: () => Promise<void>) {
    if (busy) return;
    setBusy(key);
    setError(null);
    try {
      await work();
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : "Something went wrong. Try again.",
      );
    } finally {
      setBusy(null);
    }
  }
  const openChannels = (provider: TeamProvider) =>
    action(provider, () => loadChannels(provider));
  async function loadChannels(provider: TeamProvider) {
    const result = await api<{ channels: SourceChannel[]; publicOnly?: boolean }>(
      `${base}/${provider}`,
    );
    setShared(false);
    setSearch("");
    setPicker({
      provider,
      publicOnly: result.publicOnly,
      // Channels that can be shared first; those the bot can't read last.
      channels: [...result.channels].sort((a, b) => Number(!!a.unavailable) - Number(!!b.unavailable)),
      selected:
        data?.connections
          .find((c) => c.provider === provider)
          ?.channels.map((c) => c.id) ?? [],
    });
  }
  // Every Discord server the member's account is in, after signing in with Discord.
  const listedServers = useRef(false);
  useEffect(() => {
    if (!chooseDiscord || listedServers.current) return;
    listedServers.current = true;
    onDiscordChosen?.();
    void api<{ servers: DiscordServer[] }>(`${base}/discord/servers`)
      .then((value) => {
        setServerSearch("");
        setInvite(null);
        setServers(value.servers);
      })
      .catch((cause) => setError(cause.message));
  }, [base, chooseDiscord, onDiscordChosen]);
  const chooseServer = (server: DiscordServer) =>
    action(`server:${server.id}`, async () => {
      const step =
        server.access === "ready" ? "connect" : server.access === "install" ? "install" : "invite";
      const result = await api<{ ok?: true; url?: string }>(`${base}/discord/servers`, {
        method: "POST",
        body: JSON.stringify({ guildId: server.id, action: step }),
      });
      if (step === "install" && result.url) return location.assign(result.url);
      if (step === "invite" && result.url) {
        const copied = await navigator.clipboard?.writeText(result.url).then(() => true, () => false);
        setInvite({ server: server.name, url: result.url, copied: !!copied });
        return;
      }
      setServers(null);
      await reload();
      await loadChannels("discord");
    });
  const connect = (provider: TeamProvider) =>
    action(provider, async () => {
      if (desktopBridge()?.isDesktop) {
        const params = new URLSearchParams({ org: orgSlug, connections: project.id });
        window.open(
          `${location.origin}/workspace?${params}`,
          "_blank",
          "noopener,noreferrer",
        );
        setBrowserProvider(provider);
        return;
      }
      const result = await api<{ url: string }>(`${base}/${provider}`, {
        method: "POST",
      });
      location.assign(result.url);
    });
  return (
    <>
      <div className="mt-5 flex items-center justify-between gap-3">
        <p className="text-xs text-vs-muted">
          Sources for <span className="text-vs-fg">{project.name}</span>
        </p>
        <GhostButton
          disabled={!!busy}
          onClick={() => void action("refresh", reload)}
        >
          Refresh status
        </GhostButton>
      </div>
      {error && (
        <div className="mt-3">
          <ErrorNote>{error}</ErrorNote>
        </div>
      )}
      {browserProvider && (
        <p role="status" className="mt-3 rounded-lg border border-vs-border bg-vs-editor/50 p-2.5 text-xs leading-5 text-vs-muted">
          Continue in your browser: sign in if asked, then choose Connect {names[browserProvider]} for this project.
          After choosing your channels, return here and select Refresh status.
        </p>
      )}
      {!data ? (
        <p
          role="status"
          className="mt-6 flex items-center gap-2 text-xs text-vs-muted"
        >
          <SpinnerIcon className="h-3.5 w-3.5" />
          {error ? "Use Refresh status to retry." : "Loading connections…"}
        </p>
      ) : (
        <div className="mt-3 grid gap-4 md:grid-cols-2">
          {data.providers.map((provider) => {
            const connection = data.connections.find(
              (c) => c.provider === provider.id,
            );
            return (
              <section
                key={provider.id}
                aria-label={`${names[provider.id]} connection`}
                className="flex min-w-0 flex-col rounded-2xl border border-vs-border bg-vs-panel p-4 sm:p-5"
              >
                <div className="flex items-start gap-2.5">
                  <span
                    className={`grid h-9 w-9 shrink-0 place-items-center rounded-xl text-base font-semibold ${provider.id === "slack" ? "bg-purple-500/15 text-purple-300" : "bg-indigo-500/15 text-indigo-300"}`}
                    aria-hidden
                  >
                    {provider.id === "slack" ? "#" : "D"}
                  </span>
                  <div className="min-w-0">
                    <h2 className="text-sm font-semibold">
                      {names[provider.id]}
                    </h2>
                    <p className="mt-0.5 break-words text-xs text-vs-muted">
                      {connection
                        ? connection.name
                        : "Your team’s discussions, in context"}
                    </p>
                  </div>
                </div>
                <p className="mt-4 text-xs leading-5 text-vs-muted">
                  {connection
                    ? connection.channels.length
                      ? `${connection.channels.length} selected channel${connection.channels.length === 1 ? "" : "s"}`
                      : "Connected. Choose channels to start sharing context."
                    : "Connect a workspace, then choose which channels this project can use."}
                </p>
                {!!connection?.channels.length && (
                  <ul className="mt-3 space-y-2">
                    {connection.channels.map((channel) => (
                      <li
                        key={channel.id}
                        className="rounded-lg border border-vs-border bg-vs-editor/50 px-2.5 py-2"
                      >
                        <a
                          href={channel.url}
                          target="_blank"
                          rel="noreferrer"
                          className="flex items-center justify-between gap-2 text-xs font-medium hover:text-vs-accent"
                        >
                          <span className="truncate">#{channel.name}</span>
                          <LinkIcon className="h-3 w-3 shrink-0" />
                        </a>
                        <p className="mt-1 text-[11px] leading-4 text-vs-muted">
                          {channel.error ??
                            (channel.syncedAt
                              ? !channel.verifiedAt ||
                                checkedAt - Date.parse(channel.verifiedAt) >
                                  30 * 60 * 1000
                                ? "Waiting for access verification. AI will skip this channel until then."
                                : `${channel.messageCount} messages · Synced ${new Date(channel.syncedAt).toLocaleString()}`
                              : "Waiting for the first sync. Refresh shortly.")}
                        </p>
                      </li>
                    ))}
                  </ul>
                )}
                {!provider.configured && (
                  <p className="mt-3 rounded-lg border border-vs-border bg-vs-editor/50 p-2.5 text-xs leading-5 text-vs-muted">
                    Server setup needed. Ask your administrator to enable{" "}
                    {names[provider.id]} connections.
                  </p>
                )}
                {data.canManage ? (
                  <div className="mt-auto flex flex-wrap gap-2 pt-4">
                    {connection ? (
                      <>
                        <PrimaryButton
                          disabled={!!busy || !provider.configured}
                          onClick={() => void openChannels(provider.id)}
                        >
                          Choose channels
                        </PrimaryButton>
                        <GhostButton
                          disabled={!!busy}
                          onClick={() => setDisconnect(provider.id)}
                        >
                          Disconnect
                        </GhostButton>
                      </>
                    ) : (
                      <PrimaryButton
                        disabled={!!busy || !provider.configured}
                        onClick={() => void connect(provider.id)}
                      >
                        {busy === provider.id && (
                          <SpinnerIcon className="h-3.5 w-3.5" />
                        )}
                        Connect {names[provider.id]}
                      </PrimaryButton>
                    )}
                  </div>
                ) : (
                  <p className="mt-4 text-xs text-vs-muted">
                    A project manager can manage this connection.
                  </p>
                )}
              </section>
            );
          })}
        </div>
      )}
      <div className="mt-5 rounded-xl border border-vs-border p-4 text-xs leading-5 text-vs-muted">
        <p className="font-medium text-vs-fg">Shared with this project</p>
        <p className="mt-1">
          Selected channels become context for all project members. We import
          recent text and new messages, with links to the original discussion.
          Direct messages and private channels are excluded.
        </p>
        <p className="mt-2">
          AI chats and task assignment stay here. Channel connections are
          authorised in your browser; desktop users can return here and refresh
          when finished.
        </p>
      </div>
      {picker && (
        <Modal
          title={`Choose ${names[picker.provider]} channels`}
          description={`Share selected channels with everyone in ${project.name}.`}
          onClose={() => {
            if (!busy) setPicker(null);
          }}
          footer={
            <>
              <GhostButton disabled={!!busy} onClick={() => setPicker(null)}>
                Cancel
              </GhostButton>
              <PrimaryButton
                disabled={!!busy || !shared || picker.selected.length > 10}
                onClick={() =>
                  void action("save", async () => {
                    await api(`${base}/${picker.provider}`, {
                      method: "PUT",
                      body: JSON.stringify({
                        channelIds: picker.selected,
                        shareWithProject: true,
                      }),
                    });
                    setPicker(null);
                    await reload();
                  })
                }
              >
                {busy === "save" && <SpinnerIcon className="h-4 w-4" />}Save
                channels
              </PrimaryButton>
            </>
          }
        >
          <input
            aria-label="Search channels"
            type="search"
            placeholder="Find a channel…"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            className={inputClass}
          />
          <p className="text-xs text-vs-muted">
            {picker.selected.length}/10 selected.{" "}
            {picker.provider === "slack"
              ? "Invite the Slack app to a public channel to make it appear here."
              : "Channels you can see in Discord, including ones your roles open up. Private ones are shared with everyone in this project."}
          </p>
          {picker.publicOnly && (
            <p role="status" className="rounded-lg border border-vs-border bg-vs-editor/50 p-2.5 text-xs leading-5 text-vs-muted">
              Showing only channels everyone in the server can read, because this connection was made before Discord roles were checked.{" "}
              <button type="button" className="text-vs-accent underline" disabled={!!busy}
                onClick={() => { setPicker(null); void connect("discord"); }}>
                Reconnect Discord
              </button>{" "}
              to also see channels your roles give you access to. Your chosen channels stay selected.
            </p>
          )}
          <div className="space-y-1">
            {picker.channels
              .filter((c) =>
                c.name.toLowerCase().includes(search.toLowerCase()),
              )
              .map((channel) => (
                <label
                  key={channel.id}
                  title={channel.unavailable}
                  className={`flex items-center gap-2.5 rounded-lg px-2.5 py-2 text-xs ${channel.unavailable ? "cursor-not-allowed opacity-60" : "cursor-pointer hover:bg-vs-hover"}`}
                >
                  <input
                    type="checkbox"
                    checked={picker.selected.includes(channel.id)}
                    disabled={
                      !!busy ||
                      (!!channel.unavailable && !picker.selected.includes(channel.id)) ||
                      (!picker.selected.includes(channel.id) &&
                        picker.selected.length >= 10)
                    }
                    onChange={(event) =>
                      setPicker({
                        ...picker,
                        selected: event.target.checked
                          ? [...picker.selected, channel.id]
                          : picker.selected.filter((id) => id !== channel.id),
                      })
                    }
                  />
                  <span className="min-w-0 flex-1">
                    <span className="break-all">#{channel.name}</span>
                    {channel.unavailable && <span className="block text-[11px] text-vs-muted">{channel.unavailable}</span>}
                  </span>
                  {channel.restricted && (
                    <span className="shrink-0 rounded-full border border-vs-border px-1.5 py-0.5 text-[10px] text-vs-muted" title="Not everyone in the server can read this channel">Private</span>
                  )}
                </label>
              ))}
            {!picker.channels.length && (
              <p className="py-3 text-xs text-vs-muted">
                No eligible channels yet. Add the app to a public channel, then
                reopen this list.
              </p>
            )}
          </div>
          <label className="flex items-start gap-2.5 border-t border-vs-border pt-3 text-xs leading-5">
            <input
              className="mt-1"
              type="checkbox"
              checked={shared}
              onChange={(event) => setShared(event.target.checked)}
            />
            <span>
              I’m authorised to share these channels with all project members.
              Deselecting a channel removes its imported context.
            </span>
          </label>
          {error && <ErrorNote>{error}</ErrorNote>}
        </Modal>
      )}
      {servers && (
        <Modal
          title="Choose a Discord server"
          description={`Every server your Discord account is in. Then choose which of its channels to share with ${project.name}.`}
          onClose={() => {
            if (!busy) setServers(null);
          }}
          footer={
            <GhostButton disabled={!!busy} onClick={() => setServers(null)}>
              Close
            </GhostButton>
          }
        >
          {servers.length > 6 && (
            <input
              aria-label="Search servers"
              type="search"
              placeholder="Find a server…"
              value={serverSearch}
              onChange={(event) => setServerSearch(event.target.value)}
              className={inputClass}
            />
          )}
          <ul className="space-y-1" aria-label="Your Discord servers">
            {servers
              .filter((server) =>
                server.name.toLowerCase().includes(serverSearch.toLowerCase()),
              )
              .map((server) => (
                <li
                  key={server.id}
                  className="flex items-center gap-3 rounded-lg px-2.5 py-2 text-xs hover:bg-vs-hover"
                >
                  <span className="grid h-7 w-7 shrink-0 place-items-center rounded-lg bg-indigo-500/15 font-semibold text-indigo-300">
                    {server.name.trim().charAt(0).toUpperCase() || "D"}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-vs-fg">{server.name}</span>
                    <span className="block text-[11px] text-vs-muted">
                      {server.access === "ready"
                        ? "Bot added · ready to connect"
                        : server.access === "install"
                          ? "You manage this server"
                          : "A server admin needs to add the bot"}
                    </span>
                  </span>
                  {server.access === "ask" ? (
                    <GhostButton
                      disabled={!!busy}
                      onClick={() => void chooseServer(server)}
                    >
                      {busy === `server:${server.id}` && <SpinnerIcon className="h-3.5 w-3.5" />}
                      Invite an admin
                    </GhostButton>
                  ) : (
                    <PrimaryButton
                      disabled={!!busy}
                      onClick={() => void chooseServer(server)}
                    >
                      {busy === `server:${server.id}` && <SpinnerIcon className="h-3.5 w-3.5" />}
                      {server.access === "ready" ? "Connect" : "Add bot & connect"}
                    </PrimaryButton>
                  )}
                </li>
              ))}
            {!servers.length && (
              <li className="py-3 text-xs text-vs-muted">
                Your Discord account is not in any servers yet.
              </li>
            )}
          </ul>
          {invite && (
            <div role="status" className="space-y-2 rounded-lg border border-vs-border bg-vs-editor/50 p-2.5 text-xs leading-5 text-vs-muted">
              <p>
                {invite.copied ? "Invite link copied. " : ""}Send it to someone
                who manages <span className="text-vs-fg">{invite.server}</span>.
                When they add the bot, the server connects to {project.name}
                and you can choose its channels. The link works for 7 days.
              </p>
              <input
                aria-label="Invite link for a server admin"
                readOnly
                value={invite.url}
                onFocus={(event) => event.currentTarget.select()}
                className={inputClass}
              />
            </div>
          )}
          {error && <ErrorNote>{error}</ErrorNote>}
        </Modal>
      )}
      {disconnect && (
        <Modal
          title={`Disconnect ${names[disconnect]}?`}
          description="This removes this project’s channel selection and imported messages. Original conversations stay in the chat service. Existing AI transcripts are retained."
          onClose={() => {
            if (!busy) setDisconnect(null);
          }}
          footer={
            <>
              <GhostButton
                disabled={!!busy}
                onClick={() => setDisconnect(null)}
              >
                Cancel
              </GhostButton>
              <PrimaryButton
                disabled={!!busy}
                onClick={() =>
                  void action("disconnect", async () => {
                    await api(`${base}/${disconnect}`, { method: "DELETE" });
                    setDisconnect(null);
                    await reload();
                  })
                }
              >
                Disconnect
              </PrimaryButton>
            </>
          }
        >
          {error && <ErrorNote>{error}</ErrorNote>}
        </Modal>
      )}
    </>
  );
}
