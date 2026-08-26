import { currentUser } from "../../lib/auth/tokens";
import { createOrg, listOrgsForUser } from "../../lib/org/store";
import type { CreateOrgRequest, OrgListResponse } from "../../lib/org/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Orgs the caller belongs to — the sidebar rail. */
export async function GET() {
  const user = await currentUser();
  if (!user) return Response.json({ error: "Sign in to continue." }, { status: 401 });

  const orgs = await listOrgsForUser(user.id);
  return Response.json({ orgs } satisfies OrgListResponse, {
    headers: { "cache-control": "no-store" },
  });
}

/** Create an organisation. The caller becomes its owner. */
export async function POST(request: Request) {
  const user = await currentUser();
  if (!user) return Response.json({ error: "Sign in to continue." }, { status: 401 });

  let body: CreateOrgRequest;
  try {
    body = (await request.json()) as CreateOrgRequest;
  } catch {
    return Response.json({ error: "Expected a JSON body." }, { status: 400 });
  }

  const result = await createOrg(user.id, String(body.name ?? ""), body.slug);
  if (!result.ok) return Response.json({ error: result.error }, { status: 400 });

  return Response.json(result.org, { status: 201 });
}
