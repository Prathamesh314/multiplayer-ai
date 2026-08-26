import { findByConnectCode } from "../../../../lib/repo/users";
import { forbidden, orgAccess, orgDenied } from "../../../../lib/org/auth";
import { inviteByConnectCode, inviteByEmail } from "../../../../lib/org/store";
import { canManageOrg } from "../../../../lib/org/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Body = {
  via: "connect_code" | "email";
  connectCode?: string;
  email?: string;
  role?: "admin" | "member";
};

/**
 * Invite someone to the org. Two routes: paste their connect code, or email a
 * one-time link. Both create a *pending* invitation — never a membership — and
 * only an org admin or owner may issue one.
 */
export async function POST(request: Request, context: RouteContext<"/api/orgs/[slug]/invitations">) {
  const { slug } = await context.params;
  const result = await orgAccess(slug);
  const refusal = orgDenied(result);
  if (refusal || !result) return refusal!;

  if (!canManageOrg(result.role)) {
    return forbidden("Only an admin can invite people to the organisation.");
  }

  let body: Body;
  try {
    body = (await request.json()) as Body;
  } catch {
    return Response.json({ error: "Expected a JSON body." }, { status: 400 });
  }

  const role = body.role === "admin" ? "admin" : "member";

  if (body.via === "connect_code") {
    const code = String(body.connectCode ?? "").trim().toUpperCase();
    const invitee = await findByConnectCode(code);
    if (!invitee) return Response.json({ error: "No account has that connect code." }, { status: 404 });
    if (invitee.id === result.user.id) {
      return Response.json({ error: "You are already in this organisation." }, { status: 400 });
    }

    const outcome = await inviteByConnectCode(result.org.id, invitee.id, role, result.user.id);
    if (!outcome.ok) return Response.json({ error: outcome.error }, { status: 409 });
    return Response.json({ invited: { displayName: invitee.displayName, handle: invitee.handle } }, { status: 201 });
  }

  if (body.via === "email") {
    const email = String(body.email ?? "").trim();
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
      return Response.json({ error: "That does not look like an email address." }, { status: 400 });
    }
    const outcome = await inviteByEmail(result.org.id, email, role, result.user.id);
    if (!outcome.ok) return Response.json({ error: outcome.error }, { status: 409 });

    // The link is assembled here so the token is only ever handled server-side
    // until it reaches the browser that requested it.
    const origin = new URL(request.url).origin;
    const link = `${origin}/invite/${outcome.token}`;
    return Response.json({ link, expiresAt: outcome.expiresAt }, { status: 201 });
  }

  return Response.json({ error: "Specify via: 'connect_code' or 'email'." }, { status: 400 });
}
