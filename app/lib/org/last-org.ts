/**
 * The organisation you were last in, kept in this browser so a refresh, or
 * coming back from a room, reopens it instead of your first organisation.
 * Rooms know their org's id; the overview knows both id and slug.
 */
const KEY = "multicode:last-org";

export type LastOrg = { id?: string; slug?: string };

export function rememberOrg(org: LastOrg) {
  try {
    window.localStorage.setItem(KEY, JSON.stringify({ id: org.id, slug: org.slug }));
  } catch {
    // Not remembered (private window, blocked storage); the first org is used.
  }
}

export function lastOrg(): LastOrg {
  try {
    const value = JSON.parse(window.localStorage.getItem(KEY) ?? "{}") as LastOrg;
    return value && typeof value === "object" ? { id: typeof value.id === "string" ? value.id : undefined, slug: typeof value.slug === "string" ? value.slug : undefined } : {};
  } catch {
    return {};
  }
}

/** Which org to open: the one in the address, else the last one here, else the first. */
export function pickOrg<T extends { id: string; slug: string }>(orgs: T[], requestedSlug: string | null, current: string | null): string | null {
  const last = lastOrg();
  return orgs.find((org) => org.slug === requestedSlug)?.slug
    ?? (current && orgs.some((org) => org.slug === current) ? current : undefined)
    ?? orgs.find((org) => last.id && org.id === last.id)?.slug
    ?? orgs.find((org) => last.slug && org.slug === last.slug)?.slug
    ?? orgs[0]?.slug
    ?? null;
}
