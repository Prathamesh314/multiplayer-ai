"use client";

import { LiveAvatars } from "./LiveAvatars";
import { useOrgOnline } from "./useOrgOnline";

/** "Online now": who in the org has the app open, as a facepile with a count. */
export function OrgOnlineNow({ slug, orgId, onInvite }: { slug: string; orgId: string; onInvite?: () => void }) {
  const people = useOrgOnline(slug, orgId);
  if (people === null) return null;
  const others = people.filter((person) => !person.isSelf);
  const names = others.map((person) => person.displayName.split(/\s+/)[0]);
  const summary = names.length === 0 ? "Only you right now"
    : names.length <= 2 ? `${names.join(" and ")} ${names.length === 1 ? "is" : "are"} here`
    : `${names.slice(0, 2).join(", ")} and ${names.length - 2} ${names.length - 2 === 1 ? "other" : "others"}`;
  return (
    <section aria-label="Online now" className="flex items-center gap-3 rounded-full border border-vs-border bg-vs-panel py-1.5 pl-3 pr-1.5 shadow-sm">
      <span className="flex items-center gap-1.5 text-[11px] font-medium uppercase tracking-wider text-vs-muted">
        <span className="relative flex h-2 w-2">
          <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-vs-success opacity-60" />
          <span className="relative inline-flex h-2 w-2 rounded-full bg-vs-success" />
        </span>
        Online now
        <span className="rounded-full bg-vs-success/15 px-1.5 text-[10px] tabular-nums text-vs-success">{people.length}</span>
      </span>
      <span className="hidden max-w-48 truncate text-xs text-vs-muted sm:inline">{summary}</span>
      {others.length > 0 ? (
        <LiveAvatars people={others} label="Online" title="Online now" max={5} />
      ) : onInvite ? (
        <button type="button" onClick={onInvite} className="rounded-full px-2.5 py-1 text-xs text-vs-accent hover:bg-vs-hover">Invite your team</button>
      ) : null}
    </section>
  );
}
