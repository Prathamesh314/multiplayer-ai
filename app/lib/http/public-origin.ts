type OriginEnvironment = Partial<Pick<NodeJS.ProcessEnv, "AUTH_PUBLIC_URL" | "NODE_ENV">>;

export class PublicOriginError extends Error {
  constructor() {
    super("Invitation links are unavailable. Ask your workspace administrator to check the public website address.");
  }
}

/** Public links must not inherit a container address or caller-supplied proxy headers. */
export function publicOrigin(request: Request, env: OriginEnvironment = process.env): string {
  const configured = env.AUTH_PUBLIC_URL?.trim();
  if (!configured && env.NODE_ENV === "production") throw new PublicOriginError();

  let url: URL;
  try { url = new URL(configured || request.url); }
  catch { throw new PublicOriginError(); }

  const wildcard = ["0.0.0.0", "[::]"].includes(url.hostname);
  // A local dev server can bind all interfaces while its usable URL is localhost.
  if (!configured && wildcard) url.hostname = "localhost";
  const local = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if ((configured && wildcard) || (!configured && !local) ||
      (url.protocol !== "https:" && !(url.protocol === "http:" && local)) ||
      url.username || url.password ||
      (configured && (url.pathname !== "/" || url.search || url.hash))) {
    throw new PublicOriginError();
  }
  return url.origin;
}
