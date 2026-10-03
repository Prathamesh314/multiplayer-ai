"use client";
import { useCallback, useEffect, useState } from "react";
import type { Org } from "../../lib/org/types";
import type { Project } from "../../lib/project/types";
import type { SourceChannel, TeamProvider } from "../../lib/integrations/types";
import { desktopBridge } from "../../lib/desktop";
import { LinkIcon, SpinnerIcon } from "../icons";
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
}: {
  org: Org;
  projects: Project[];
  selectedId: string | null;
  onSelect: (id: string) => void;
}) {
  const project = projects.find((p) => p.id === selectedId) ?? projects[0];
  return (
    <main className="app-page vs-scroll min-h-0 min-w-0 flex-1 overflow-y-auto">
      <div className="mx-auto max-w-4xl px-5 py-8 sm:px-8 lg:py-10">
        <p className="text-xs font-medium uppercase tracking-[0.18em] text-vs-muted">
          Project context
        </p>
        <h1 className="font-display mt-3 text-3xl font-semibold tracking-tight">
          Bring your conversations along
        </h1>
        <p className="mt-3 max-w-2xl text-sm leading-6 text-vs-muted">
          Keep talking where your team already works. Connect selected Slack or
          Discord channels so AI can refer to your discussions and link back to
          the source.
        </p>
        <label className="mt-7 block max-w-sm text-sm font-medium">
          Project
          <select
            aria-label="Project for connections"
            value={project?.id ?? ""}
            onChange={(event) => onSelect(event.target.value)}
            className={`${inputClass} mt-2`}
          >
            {!projects.length && (
              <option value="">No projects available</option>
            )}
            {projects.map((item) => (
              <option key={item.id} value={item.id}>
                {item.name}
              </option>
            ))}
          </select>
        </label>
        {project ? (
          <ProjectConnections
            key={project.id}
            orgSlug={org.slug}
            project={project}
          />
        ) : (
          <p className="mt-6 text-sm text-vs-muted">
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
}: {
  orgSlug: string;
  project: Project;
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
  } | null>(null);
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
    action(provider, async () => {
      const result = await api<{ channels: SourceChannel[] }>(
        `${base}/${provider}`,
      );
      setShared(false);
      setSearch("");
      setPicker({
        provider,
        channels: result.channels,
        selected:
          data?.connections
            .find((c) => c.provider === provider)
            ?.channels.map((c) => c.id) ?? [],
      });
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
      <div className="mt-6 flex items-center justify-between gap-3">
        <p className="text-sm text-vs-muted">
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
        <div className="mt-4">
          <ErrorNote>{error}</ErrorNote>
        </div>
      )}
      {browserProvider && (
        <p role="status" className="mt-4 rounded-lg border border-vs-border bg-vs-editor/50 p-3 text-sm leading-6 text-vs-muted">
          Continue in your browser: sign in if asked, then choose Connect {names[browserProvider]} for this project.
          After choosing your channels, return here and select Refresh status.
        </p>
      )}
      {!data ? (
        <p
          role="status"
          className="mt-8 flex items-center gap-2 text-sm text-vs-muted"
        >
          <SpinnerIcon className="h-4 w-4" />
          {error ? "Use Refresh status to retry." : "Loading connections…"}
        </p>
      ) : (
        <div className="mt-4 grid gap-5 md:grid-cols-2">
          {data.providers.map((provider) => {
            const connection = data.connections.find(
              (c) => c.provider === provider.id,
            );
            return (
              <section
                key={provider.id}
                aria-label={`${names[provider.id]} connection`}
                className="flex min-w-0 flex-col rounded-2xl border border-vs-border bg-vs-panel p-5 sm:p-6"
              >
                <div className="flex items-start gap-3">
                  <span
                    className={`grid h-11 w-11 shrink-0 place-items-center rounded-xl text-xl font-semibold ${provider.id === "slack" ? "bg-purple-500/15 text-purple-300" : "bg-indigo-500/15 text-indigo-300"}`}
                    aria-hidden
                  >
                    {provider.id === "slack" ? "#" : "D"}
                  </span>
                  <div className="min-w-0">
                    <h2 className="text-lg font-semibold">
                      {names[provider.id]}
                    </h2>
                    <p className="mt-1 break-words text-sm text-vs-muted">
                      {connection
                        ? connection.name
                        : "Your team’s discussions, in context"}
                    </p>
                  </div>
                </div>
                <p className="mt-5 text-sm leading-6 text-vs-muted">
                  {connection
                    ? connection.channels.length
                      ? `${connection.channels.length} selected channel${connection.channels.length === 1 ? "" : "s"}`
                      : "Connected. Choose channels to start sharing context."
                    : "Connect a workspace, then choose which public channels this project can use."}
                </p>
                {!!connection?.channels.length && (
                  <ul className="mt-4 space-y-3">
                    {connection.channels.map((channel) => (
                      <li
                        key={channel.id}
                        className="rounded-lg border border-vs-border bg-vs-editor/50 px-3 py-2.5"
                      >
                        <a
                          href={channel.url}
                          target="_blank"
                          rel="noreferrer"
                          className="flex items-center justify-between gap-2 text-sm font-medium hover:text-vs-accent"
                        >
                          <span className="truncate">#{channel.name}</span>
                          <LinkIcon className="h-3.5 w-3.5 shrink-0" />
                        </a>
                        <p className="mt-1 text-xs leading-5 text-vs-muted">
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
                  <p className="mt-4 rounded-lg border border-vs-border bg-vs-editor/50 p-3 text-sm leading-6 text-vs-muted">
                    Server setup needed. Ask your administrator to enable{" "}
                    {names[provider.id]} connections.
                  </p>
                )}
                {data.canManage ? (
                  <div className="mt-auto flex flex-wrap gap-2 pt-5">
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
                          <SpinnerIcon className="h-4 w-4" />
                        )}
                        Connect {names[provider.id]}
                      </PrimaryButton>
                    )}
                  </div>
                ) : (
                  <p className="mt-5 text-sm text-vs-muted">
                    A project manager can manage this connection.
                  </p>
                )}
              </section>
            );
          })}
        </div>
      )}
      <div className="mt-6 rounded-xl border border-vs-border p-5 text-sm leading-6 text-vs-muted">
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
          description={`Share selected public channels with everyone in ${project.name}.`}
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
          <p className="text-sm text-vs-muted">
            {picker.selected.length}/10 selected.{" "}
            {picker.provider === "slack"
              ? "Invite the Slack app to a public channel to make it appear here."
              : "The bot needs View Channel and Read Message History permissions."}
          </p>
          <div className="space-y-1">
            {picker.channels
              .filter((c) =>
                c.name.toLowerCase().includes(search.toLowerCase()),
              )
              .map((channel) => (
                <label
                  key={channel.id}
                  className="flex cursor-pointer items-center gap-3 rounded-lg px-3 py-3 text-sm hover:bg-vs-hover"
                >
                  <input
                    type="checkbox"
                    checked={picker.selected.includes(channel.id)}
                    disabled={
                      !!busy ||
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
                  <span className="break-all">#{channel.name}</span>
                </label>
              ))}
            {!picker.channels.length && (
              <p className="py-4 text-sm text-vs-muted">
                No eligible channels yet. Add the app to a public channel, then
                reopen this list.
              </p>
            )}
          </div>
          <label className="flex items-start gap-3 border-t border-vs-border pt-4 text-sm leading-6">
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
