import { withApiLimit } from "../../../../lib/http/api-limit";
import { forbidden, orgAccess, orgDenied } from "../../../../lib/org/auth";
import { updateOrgDetails } from "../../../../lib/org/store";
import { canManageOrg } from "../../../../lib/org/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Body = {
  name?: string;
  image?: string | null;
};

/**
 * Update organisation settings (name and avatar/image).
 * Only an org admin or owner can update organisation details.
 */
async function handlePATCH(
  request: Request,
  context: RouteContext<"/api/orgs/[slug]/settings">,
) {
  const { slug } = await context.params;
  const result = await orgAccess(slug);
  const refusal = orgDenied(result);
  if (refusal || !result) return refusal!;

  if (!canManageOrg(result.role)) {
    return forbidden("Only an admin can update organisation settings.");
  }

  let body: Body;
  try {
    body = (await request.json()) as Body;
  } catch {
    return Response.json({ error: "Expected a JSON body." }, { status: 400 });
  }

  const name = typeof body.name === "string" ? body.name.trim() : undefined;
  const image = body.image !== undefined ? body.image : undefined;

  if (name !== undefined && name.length === 0) {
    return Response.json({ error: "Organisation name cannot be empty." }, { status: 400 });
  }

  if (name !== undefined && name.length > 64) {
    return Response.json({ error: "Organisation name is too long (max 64 characters)." }, { status: 400 });
  }

  // Guard against payloads exceeding max column or transit size (~3MB Base64)
  if (image && typeof image === "string" && image.length > 4 * 1024 * 1024) {
    return Response.json({ error: "Image file is too large." }, { status: 413 });
  }

  const updatedOrg = await updateOrgDetails(result.org.id, {
    name,
    image,
  });

  return Response.json(
    {
      id: updatedOrg.id,
      name: updatedOrg.name,
      slug: updatedOrg.slug,
      image: updatedOrg.image,
      myRole: result.role,
    },
    { status: 200 },
  );
}

export const PATCH = withApiLimit("/api/orgs/[slug]/settings", handlePATCH);
