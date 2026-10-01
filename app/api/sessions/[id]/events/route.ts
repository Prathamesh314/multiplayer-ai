import { events } from "../../../../lib/events";
import { eventResponse } from "../../../../lib/events/response";
import { access, denied } from "../../../../lib/session/auth";
import { sessionUserResolver } from "../../../../lib/auth/tokens";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function GET(request: Request, context: RouteContext<"/api/sessions/[id]/events">) {
  const { id } = await context.params;
  const resolveUser = await sessionUserResolver();
  const result = await access(id, resolveUser);
  const refusal = denied(result);
  if (refusal || !result) return refusal!;
  const bus = await events();
  return eventResponse(request, (send, close) => {
    let checking = false;
    return bus.subscribe(id, event => {
      if (event.type === "role.changed" && event.userId === result.user.id) {
        checking = true;
        void access(id, resolveUser).then(current => {
          send(event);
          if (!current) close();
          else { checking = false; send({ type: "resync", at: Date.now() }); }
        }).catch(close);
      } else if (!checking) send(event);
    });
  }, {
    validate: async () => !!await access(id, resolveUser),
  });
}
