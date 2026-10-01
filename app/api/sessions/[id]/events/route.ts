import { events } from "../../../../lib/events";
import { eventResponse } from "../../../../lib/events/response";
import { access, denied } from "../../../../lib/session/auth";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function GET(request: Request, context: RouteContext<"/api/sessions/[id]/events">) {
  const { id } = await context.params;
  const result = await access(id);
  const refusal = denied(result);
  if (refusal || !result) return refusal!;
  const bus = await events();
  return eventResponse(request, (send, close) => {
    let checking = false;
    return bus.subscribe(id, event => {
      if (event.type === "role.changed" && event.userId === result.user.id) {
        checking = true;
        void access(id).then(current => {
          send(event);
          if (!current) close();
          else { checking = false; send({ type: "resync", at: Date.now() }); }
        }).catch(close);
      } else if (!checking) send(event);
    });
  }, {
    validate: async () => !!await access(id),
  });
}
