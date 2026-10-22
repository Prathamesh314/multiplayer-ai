"use client";

import { useEffect, useState } from "react";
import { startHeartbeat } from "../../lib/presence/client";
import type { OrgOnlineResponse } from "../../lib/org/types";

export type OrgOnlinePerson = OrgOnlineResponse["people"][number];

/**
 * Who in the org has the app open. Being on these pages counts as online too
 * (a heartbeat naming the org); the list is re-read after each heartbeat, so it
 * follows people arriving and leaving within one beat.
 */
export function useOrgOnline(slug: string, orgId: string): OrgOnlinePerson[] | null {
  const [people, setPeople] = useState<OrgOnlinePerson[] | null>(null);
  useEffect(() => {
    let cancelled = false;
    let controller: AbortController | null = null;
    const load = () => {
      controller?.abort();
      controller = new AbortController();
      fetch(`/api/orgs/${encodeURIComponent(slug)}/online`, { cache: "no-store", signal: controller.signal })
        .then((response) => (response.ok ? response.json() as Promise<OrgOnlineResponse> : null))
        .then((body) => { if (!cancelled && body) setPeople(body.people); })
        .catch(() => {});
    };
    const beat = startHeartbeat({ orgId, onBeat: load });
    return () => { cancelled = true; controller?.abort(); beat.stop(); };
  }, [slug, orgId]);
  return people;
}
