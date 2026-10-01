import { access, denied, forbidden } from "../../../lib/session/auth";
import {
  addMember,
  removeMember,
  renameSession,
  setPinned,
  setVisibility,
} from "../../../lib/session/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(_request: Request, context: RouteContext<"/api/sessions/[id]">) {
  const { id } = await context.params;
  const result = await access(id);
  const refusal = denied(result);
  if (refusal || !result) return refusal!;

  return Response.json(result.session, { headers: { "cache-control": "no-store" } });
}

export async function PATCH(request: Request, context: RouteContext<"/api/sessions/[id]">) {
  const { id } = await context.params;
  const result = await access(id);
  const refusal = denied(result);
  if (refusal || !result) return refusal!;

  // Settings belong to whoever owns the room, plus anyone whose project role
  // already derives to owner (managers). Ownership is checked directly because
  // in a public project room the derived role shadows the roster: an editor's
  // own member room must still be theirs to rename.
  if (result.role !== "owner" && result.session.ownerId !== result.user.id) {
    return forbidden("Only the session owner can change its settings.");
  }

  let body: { name?: unknown; pinned?: unknown; visibility?: unknown };
  try {
    body = (await request.json()) as { name?: unknown; pinned?: unknown; visibility?: unknown };
  } catch {
    return Response.json({ error: "Expected a JSON body." }, { status: 400 });
  }

  // The pinned preference can be updated independently of the room name.
  let updated =
    typeof body.pinned === "boolean" ? await setPinned(id, body.pinned) : null;

  if (body.visibility === "public" || body.visibility === "private") {
    // Going private makes access roster-only, so the person doing it must be on
    // the roster or they would lock themselves out (a project manager reaching
    // a public room has no roster row of their own).
    if (body.visibility === "private") {
      await addMember(id, result.user.id, "owner", "owner");
    }
    updated = (await setVisibility(id, body.visibility)) ?? updated;
  }

  if (typeof body.name === "string") {
    updated = (await renameSession(id, body.name)) ?? updated;
    if (!updated) {
      return Response.json({ error: "A session name is required." }, { status: 400 });
    }
  }

  if (!updated) return Response.json({ error: "Nothing to update." }, { status: 400 });

  return Response.json(updated);
}

/**
 * Leaving drops this account from the roster. The session itself stays alive —
 * and the owner cannot leave, because a session with no owner has nobody who
 * can delete it.
 */
export async function DELETE(_request: Request, context: RouteContext<"/api/sessions/[id]">) {
  const { id } = await context.params;
  const result = await access(id);
  const refusal = denied(result);
  if (refusal || !result) return refusal!;

  if (result.role === "owner") {
    return forbidden("The owner cannot leave their own session.");
  }

  await removeMember(id, result.user.id);
  return Response.json({ left: true });
}
