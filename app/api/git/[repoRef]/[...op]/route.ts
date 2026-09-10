import { spawn } from "node:child_process";
import { stat } from "node:fs/promises";
import { Readable } from "node:stream";
import type { ReadableStream as NodeReadableStream } from "node:stream/web";
import { createGunzip } from "node:zlib";
import { bearerToken, deviceFromToken } from "../../../../lib/runner/devices";
import { resolveGitAccess } from "../../../../lib/runner/git-access";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/*
 * Git smart-HTTP over the server's bare repos — the repo transport of the
 * local-execution plan (docs/local-execution.md §3.4).
 *
 * A runner on a user's machine clones and pushes through these two routes:
 *
 *   GET  /api/git/<repoRef>/info/refs?service=git-upload-pack|git-receive-pack
 *   POST /api/git/<repoRef>/git-upload-pack | git-receive-pack
 *
 * Each request pipes through the real git in stateless-RPC mode — this code
 * moves bytes and enforces authz; the protocol itself stays git's problem.
 * Authentication is a device token (never the web cookie), and authorization
 * is the user's room role: read for upload-pack, write for receive-pack.
 *
 * Push discipline: no deletes, no force-pushes (denyNonFastForwards). What a
 * runner may land is therefore only history that extends what it fetched —
 * and the /complete report is verified against the bare repo afterwards, so a
 * runner cannot claim a commit it never pushed.
 */

const SERVICES = new Set(["git-upload-pack", "git-receive-pack"]);

/** Pinned config, mirroring app/lib/session/repo.ts — behave the same everywhere. */
const GIT_ENV = {
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_TERMINAL_PROMPT: "0",
};

const encoder = new TextEncoder();

/** One pkt-line: 4-hex length prefix that includes itself. */
const pkt = (line: string): string => (line.length + 4).toString(16).padStart(4, "0") + line;

const refuse = (status: number, message: string): Response =>
  Response.json({ error: message }, { status, headers: { "cache-control": "no-store" } });

/**
 * Resolve auth + authz for one request, or answer why not. 401 for a missing/
 * revoked token; 404 for everything else (unknown ref, no role, read-only
 * pushing) so the surface cannot be used to probe which repos exist.
 */
async function gate(request: Request, repoRef: string, write: boolean) {
  const device = await deviceFromToken(bearerToken(request));
  if (!device) return { error: refuse(401, "Unknown or revoked device token.") };

  const access = await resolveGitAccess(repoRef, device.userId, write);
  if (!access) return { error: refuse(404, "Not found.") };

  const bareExists = await stat(access.bare).then((s) => s.isDirectory()).catch(() => false);
  if (!bareExists) return { error: refuse(404, "Not found.") };
  return { bare: access.bare };
}

/** Spawn the git service and hand its stdout back as a streaming response body. */
function streamGit(
  args: string[],
  options: { stdin?: Readable; gitProtocol?: string | null },
  prefix?: string,
): ReadableStream<Uint8Array> {
  const child = spawn("git", args, {
    env: { ...process.env, ...GIT_ENV, ...(options.gitProtocol ? { GIT_PROTOCOL: options.gitProtocol } : {}) },
    windowsHide: true,
  });
  if (options.stdin) options.stdin.pipe(child.stdin);
  else child.stdin.end();
  // Protocol errors surface to the client through the stream; the server log
  // is the place operators will actually debug a broken clone from.
  child.stderr.on("data", (chunk: Buffer) => console.error(`git ${args[0]}: ${chunk}`));

  return new ReadableStream<Uint8Array>({
    start(controller) {
      if (prefix) controller.enqueue(encoder.encode(prefix));
      child.stdout.on("data", (chunk: Buffer) => {
        try {
          controller.enqueue(new Uint8Array(chunk));
        } catch {
          child.kill("SIGKILL"); // reader gone
        }
      });
      child.stdout.on("end", () => {
        try {
          controller.close();
        } catch {
          // Already closed.
        }
      });
      child.on("error", (cause) => controller.error(cause));
    },
    cancel() {
      child.kill("SIGKILL");
    },
  });
}

/** The request body as a Node stream, transparently gunzipped (git gzips pushes). */
function bodyStream(request: Request): Readable {
  const raw = request.body
    ? Readable.fromWeb(request.body as unknown as NodeReadableStream)
    : Readable.from([]);
  return request.headers.get("content-encoding") === "gzip" ? raw.pipe(createGunzip()) : raw;
}

/** Ref advertisement: what the client asks first, for both clone and push. */
export async function GET(request: Request, context: RouteContext<"/api/git/[repoRef]/[...op]">) {
  const { repoRef, op } = await context.params;
  if (op.join("/") !== "info/refs") return refuse(404, "Not found.");

  const service = new URL(request.url).searchParams.get("service") ?? "";
  if (!SERVICES.has(service)) {
    // The dumb-HTTP protocol lands here; only smart clients are supported.
    return refuse(400, "Smart HTTP only.");
  }

  const write = service === "git-receive-pack";
  const gated = await gate(request, repoRef, write);
  if ("error" in gated) return gated.error;

  const body = streamGit(
    [service.slice(4), "--stateless-rpc", "--advertise-refs", gated.bare],
    { gitProtocol: request.headers.get("git-protocol") },
    pkt(`# service=${service}\n`) + "0000",
  );
  return new Response(body, {
    headers: {
      "content-type": `application/x-${service}-advertisement`,
      "cache-control": "no-store",
    },
  });
}

/** The service call itself: pack negotiation (clone/fetch) or a push. */
export async function POST(request: Request, context: RouteContext<"/api/git/[repoRef]/[...op]">) {
  const { repoRef, op } = await context.params;
  const service = op.join("/");
  if (!SERVICES.has(service)) return refuse(404, "Not found.");

  const write = service === "git-receive-pack";
  const gated = await gate(request, repoRef, write);
  if ("error" in gated) return gated.error;

  const args = write
    ? [
        // Push discipline lives here, not in the runner's goodwill.
        "-c", "receive.denyNonFastForwards=true",
        "-c", "receive.denyDeletes=true",
        "receive-pack", "--stateless-rpc", gated.bare,
      ]
    : ["upload-pack", "--stateless-rpc", gated.bare];

  const body = streamGit(args, {
    stdin: bodyStream(request),
    gitProtocol: request.headers.get("git-protocol"),
  });
  return new Response(body, {
    headers: {
      "content-type": `application/x-${service}-result`,
      "cache-control": "no-store",
    },
  });
}
