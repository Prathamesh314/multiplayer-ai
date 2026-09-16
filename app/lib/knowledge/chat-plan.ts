/** Pure, explainable query planning for human project-room discussions. */
export type ChatRoom = { id: string; name: string };
export type ChatPerson = { id: string; handle: string; name: string };
export type ChatPlan = {
  roomIds: string[];
  authorIds: string[];
  terms: string[];
  /** Unknown/ambiguous explicit selectors must never broaden a search. */
  unresolved: string[];
  /** Explicit calendar phrases use UTC, matching stored timestamps. */
  since: string | null;
  until: string | null;
};

const STOP_WORDS = new Set(`a an the and or but of to in on at for from with about as by
  is are was were be been being do does did have has had we us our i me my you your
  it its this that these those they them their what which who when where why how
  can could would should will please need want use using make implement fix build
  according based follow following discussed discuss discussion discussions decided
  decide decision decisions agreed agree said say mentioned mention talked talk
  proposed suggested feedback requirements requirement specification discussing
  conversation conversations chat chats room rooms channel channels group groups team
  meeting standup recap summary summarize summarise context history earlier previously
  yesterday today last past week time latest recent recently catch up tell show find fetch
  get look remember recall all any some then also more`.split(/\s+/));

function phrasePattern(value: string): RegExp {
  const escaped = value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(^|[^\\p{L}\\p{N}_])(${escaped})(?=$|[^\\p{L}\\p{N}_-])`, "giu");
}

export function planChatQuery(prompt: string, rooms: ChatRoom[], people: ChatPerson[], now = new Date()): ChatPlan {
  let search = prompt;
  const roomIds = new Set<string>();
  const authorIds = new Set<string>();
  const unresolved: string[] = [];
  let since: string | null = null;
  let until: string | null = null;
  const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const day = 86_400_000;
  if (/\byesterday\b/i.test(prompt)) {
    since = new Date(today - day).toISOString();
    until = new Date(today).toISOString();
  } else if (/\btoday\b/i.test(prompt)) {
    since = new Date(today).toISOString();
  } else if (/\b(?:last|past) week\b/i.test(prompt)) {
    since = new Date(now.getTime() - 7 * day).toISOString();
  }

  // #room / #"Room name" and @handle are explicit selectors. A run reference
  // @room/uuid belongs to the existing reference layer, not an author filter.
  search = search.replace(/(^|\s)([#@])(?:"([^"]+)"|([\p{L}\p{N}_-]+))(?![\p{L}\p{N}_/-])/gu,
    (whole, prefix: string, marker: string, quoted: string, bare: string) => {
      const value = (quoted ?? bare).toLowerCase();
      const matches = marker === "#"
        ? rooms.filter((room) => room.name.toLowerCase() === value || room.id === value)
        : people.filter((person) => person.handle.toLowerCase() === value);
      if (matches.length === 1) {
        (marker === "#" ? roomIds : authorIds).add(matches[0].id);
      } else {
        unresolved.push(whole.trim());
      }
      return prefix;
    });

  // Natural names are resolved only against the visible directory. Require a
  // room/channel phrase for bare room names to avoid treating a topic as a room.
  for (const room of rooms) {
    const escaped = room.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const pattern = new RegExp(`\\b(?:in|from)\\s+(?:the\\s+)?${escaped}\\s+(?:room|channel|group)\\b|\\b(?:room|channel|group)\\s+["']?${escaped}["']?(?=$|[\\s,.?!])`, "gi");
    if (pattern.test(search)) {
      const sameName = rooms.filter((r) => r.name.toLowerCase() === room.name.toLowerCase());
      if (sameName.length === 1) roomIds.add(room.id);
      else unresolved.push(room.name);
      search = search.replace(pattern, " ");
    }
  }
  // Longest first: resolve "Alice Smith" before the handle "alice" so the
  // surname doesn't accidentally become a topic search term.
  const aliases = [...new Set(people.flatMap((person) => [person.handle, person.name]))]
    .sort((a, b) => b.length - a.length);
  for (const alias of aliases) {
    if (!alias.trim() || !phrasePattern(alias).test(search)) continue;
    const matches = people.filter((p) => [p.handle, p.name].some((n) => n.toLowerCase() === alias.toLowerCase()));
    if (matches.length === 1) authorIds.add(matches[0].id);
    else unresolved.push(alias);
    search = search.replace(phrasePattern(alias), " ");
  }

  const terms = [...new Set((search.toLowerCase().match(/[\p{L}\p{N}_]+/gu) ?? [])
    .filter((term) => term.length > 1 && !STOP_WORDS.has(term)))].slice(0, 24);
  return { roomIds: [...roomIds], authorIds: [...authorIds], terms, unresolved, since, until };
}
