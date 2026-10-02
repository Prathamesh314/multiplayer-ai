import { withApiLimit } from "../../../../lib/http/api-limit";
import { currentUser } from "../../../../lib/auth/tokens";
import {
  consumeOAuthState,
  connectProject,
} from "../../../../lib/integrations/store";
import { adapterFor } from "../../../../lib/integrations/providers";
import {
  configured,
  integrationOrigin,
} from "../../../../lib/integrations/config";
import { isProvider } from "../../../../lib/integrations/types";
import { integrationFailure } from "../../../../lib/integrations/http";
import { queryOne } from "../../../../lib/db/client";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
async function handleGET(
  request: Request,
  context: RouteContext<"/api/integrations/[provider]/callback">,
) {
  const { provider } = await context.params;
  if (!isProvider(provider) || !configured(provider))
    return Response.json(
      { error: "This provider is not configured." },
      { status: 503 },
    );
  const user = await currentUser();
  if (!user)
    return Response.json(
      {
        error:
          "Sign in to the app in this browser, then start the connection again.",
      },
      { status: 401 },
    );
  const url = new URL(request.url);
  try {
    const project = await consumeOAuthState(
      url.searchParams.get("state") ?? "",
      user.id,
      provider,
    );
    if (url.searchParams.has("error"))
      return Response.redirect(
        `${integrationOrigin()}/workspace?connection=cancelled`,
        303,
      );
    const code = url.searchParams.get("code");
    if (!code || code.length > 2048)
      return Response.json(
        { error: "Missing authorization code. Start the connection again." },
        { status: 400 },
      );
    const source = await adapterFor(provider).exchange(code);
    await connectProject(project, user.id, provider, source);
    const organisation = await queryOne<{ slug: string }>(
      "SELECT o.slug FROM projects p JOIN orgs o ON o.id=p.org_id WHERE p.id=$1",
      [project],
    );
    return Response.redirect(
      `${integrationOrigin()}/workspace?${new URLSearchParams({ connections: project, connected: provider, org: organisation?.slug ?? "" })}`,
      303,
    );
  } catch (error) {
    return integrationFailure(error);
  }
}
export const GET = withApiLimit(
  "/api/integrations/[provider]/callback",
  handleGET,
);
