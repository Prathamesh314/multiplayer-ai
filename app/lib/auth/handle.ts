import { randomBytes } from "node:crypto";

/** An internal mention handle should not add another step to account creation. */
export function generatedHandle(displayName: string, email: string): string {
  const name = displayName.trim() || email.split("@")[0];
  const base = name.normalize("NFKD").replace(/[\u0300-\u036f]/g, "")
    .toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 24) || "member";
  return `${base}-${randomBytes(4).toString("hex")}`;
}
