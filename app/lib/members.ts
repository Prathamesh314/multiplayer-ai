export type MemberStatus = "online" | "idle" | "offline";

export type Member = {
  id: string;
  name: string;
  initials: string;
  role: string;
  status: MemberStatus;
  /** Tailwind classes for the avatar chip. */
  avatar: string;
};

/**
 * Placeholder roster. Presence is not wired to a backend yet — these seed the
 * collaboration UI so the layout can be built and reviewed.
 */
export const TEAM: Member[] = [
  {
    id: "you",
    name: "You",
    initials: "YO",
    role: "Owner",
    status: "online",
    avatar: "bg-sky-600 text-white",
  },
  {
    id: "ada",
    name: "Ada Lovelace",
    initials: "AL",
    role: "Backend",
    status: "online",
    avatar: "bg-violet-600 text-white",
  },
  {
    id: "grace",
    name: "Grace Hopper",
    initials: "GH",
    role: "Compilers",
    status: "online",
    avatar: "bg-emerald-600 text-white",
  },
  {
    id: "linus",
    name: "Linus T.",
    initials: "LT",
    role: "Infra",
    status: "idle",
    avatar: "bg-amber-600 text-white",
  },
];

export const STATUS_COLOR: Record<MemberStatus, string> = {
  online: "bg-emerald-500",
  idle: "bg-amber-500",
  offline: "bg-zinc-500",
};
