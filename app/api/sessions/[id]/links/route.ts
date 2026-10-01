import { withApiLimit } from "../../../../lib/http/api-limit";
import { access, denied, forbidden } from "../../../../lib/session/auth";
import {
  createShareLink,
  listShareLinks,
  revokeShareLink,
} from "../../../../lib/session/store";
import type {
  CreateShareLinkRequest,
  CreateShareLinkResponse,
  ShareLinksResponse,
  ShareRole,
} from "../../../../lib/session/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ROLES: ShareRole[] = ["viewer", "editor"];

/** Only the owner manages links — an editor handing out editor links would
 *  make the owner's control over their own session nominal. */
async function asOwner(id: string) {
  const result = await access(id);
  const refusal = denied(result);
  if (refusal || !result) return { refusal: refusal!, result: null };
  if (result.role !== "owner") {
    return { refusal: forbidden("Only the session owner can manage share links."), result: null };
  }
  return { refusal: null, result };
}

async function handleGET(_request: Request, context: RouteContext<"/api/sessions/[id]/links">) {
  const { id } = await context.params;
  const { refusal } = await asOwner(id);
  if (refusal) return refusal;

  return Response.json({ links: await listShareLinks(id) } satisfies ShareLinksResponse, {
    headers: { "cache-control": "no-store" },
  });
}

/**
 * Mints a link. The token comes back exactly once — only its hash is stored,
 * so a link that is lost has to be revoked and replaced rather than recovered.
 */
async function handlePOST(request: Request, context: RouteContext<"/api/sessions/[id]/links">) {
  const { id } = await context.params;
  const { refusal, result } = await asOwner(id);
  if (refusal || !result) return refusal!;

  let body: CreateShareLinkRequest;
  try {
    body = (await request.json()) as CreateShareLinkRequest;
  } catch {
    return Response.json({ error: "Expected a JSON body." }, { status: 400 });
  }

  if (!ROLES.includes(body.role)) {
    return Response.json(
      { error: "A share link can grant view or edit access." },
      { status: 400 },
    );
  }

  const created = await createShareLink(id, body.role, result.user.id, {
    label: typeof body.label === "string" ? body.label.slice(0, 60) : null,
    expiresInDays: typeof body.expiresInDays === "number" ? body.expiresInDays : null,
  });

  return Response.json(created satisfies CreateShareLinkResponse, { status: 201 });
}

async function handleDELETE(request: Request, context: RouteContext<"/api/sessions/[id]/links">) {
  const { id } = await context.params;
  const { refusal } = await asOwner(id);
  if (refusal) return refusal;

  const linkId = new URL(request.url).searchParams.get("linkId");
  if (!linkId) return Response.json({ error: "A linkId is required." }, { status: 400 });

  const revoked = await revokeShareLink(id, linkId);
  if (!revoked) return Response.json({ error: "No such link." }, { status: 404 });

  // Revoking stops future redemptions. People who already joined keep the
  // access they were granted — remove them from the roster to change that.
  return Response.json({ revoked: true });
}

export const GET = withApiLimit("/api/sessions/[id]/links", handleGET);
export const POST = withApiLimit("/api/sessions/[id]/links", handlePOST);
export const DELETE = withApiLimit("/api/sessions/[id]/links", handleDELETE);
