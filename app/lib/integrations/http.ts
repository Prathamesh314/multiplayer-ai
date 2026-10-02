import { orgDenied, projectAccess } from "../org/auth";
import { IntegrationError } from "./types";
export async function integrationAccess(
  slug: string,
  projectSlug: string,
  write = false,
) {
  const result = await projectAccess(slug, projectSlug),
    denial = orgDenied(result);
  if (denial || !result) return { response: denial! };
  if (write && (result.role !== "manager" || result.project.archivedAt))
    return {
      response: Response.json(
        {
          error: "Only a manager of an active project can change connections.",
        },
        { status: 403 },
      ),
    };
  return { access: result };
}
export function integrationFailure(error: unknown) {
  return Response.json(
    {
      error:
        error instanceof IntegrationError
          ? error.message
          : "Could not complete the connection request. Please try again.",
    },
    {
      status: error instanceof IntegrationError ? error.status : 503,
      headers:
        error instanceof IntegrationError && error.status === 429
          ? { "retry-after": String(error.retryAfter) }
          : undefined,
    },
  );
}
