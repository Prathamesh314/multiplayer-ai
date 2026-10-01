import { sessionUserResolver } from "../../lib/auth/tokens";
import { events } from "../../lib/events";
import { eventResponse } from "../../lib/events/response";
import { query } from "../../lib/db/client";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function GET(request: Request) {
  const resolveUser = await sessionUserResolver();
  const user = await resolveUser();
  if (!user) return Response.json({ error: "Sign in to continue." }, { status: 401 });
  const orgs = await query<{ org_id: string }>("SELECT org_id FROM org_members WHERE user_id=$1 AND status='active'", [user.id]);
  const bus = await events();
  return eventResponse(request, async send => {
    const off: (() => Promise<void>)[] = [];
    try {
      off.push(await bus.subscribe(`user:${user.id}`, event => { if (event.type !== "runner.work") send(event); }));
      for (const org of orgs) off.push(await bus.subscribe(`org:${org.org_id}`, event => {
        // Organizational signals contain no data; normal reads recheck access.
        if (event.type === "usage.changed") send(event);
      }));
    } catch (error) { await Promise.all(off.map(fn => fn())); throw error; }
    return async () => { await Promise.all(off.map(fn => fn())); };
  }, { validate: async () => (await resolveUser())?.id === user.id });
}
