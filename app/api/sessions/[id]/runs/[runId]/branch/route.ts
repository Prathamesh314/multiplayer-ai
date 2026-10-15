import { withApiLimit } from "../../../../../../lib/http/api-limit";
import { access, canWrite, denied, forbidden } from "../../../../../../lib/session/auth";
import { isUuid, ControlError } from "../../../../../../lib/ai/turns";
import { safeRelativePath } from "../../../../../../lib/session/paths";
import {
  chatBranchState, chatFileDiff, mergeChatIntoRoom, setChatDiscarded, updateChatFromRoom,
  type ChatBranchState, type ChatMergeOutcome, type ChatUpdateOutcome,
} from "../../../../../../lib/ai/chat-branch";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export type ChatBranchResponse = ChatBranchState;
export type ChatFileDiffResponse = { diff: string };
export type ChatBranchActionRequest =
  | { action: "merge"; expectedChatHead: string; expectedRoomHead: string }
  | { action: "update"; version: number; expectedChatHead: string; expectedRoomHead: string; allowConflicts?: boolean }
  | { action: "discard" | "reopen" };
export type ChatBranchActionResponse = ChatMergeOutcome | ChatUpdateOutcome | { ok: true; mergeState: string };

const SHA = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;
type Context = { params: Promise<{ id: string; runId: string }> };

async function gate(context: Context) {
  const { id, runId } = await context.params;
  const result = await access(id);
  const refusal = denied(result);
  if (refusal || !result) return refusal!;
  if (!isUuid(runId)) return Response.json({ error: "Chat not found." }, { status: 404 });
  return { result, runId, sessionId: result.session.id };
}

const failure = (cause: unknown) => {
  if (cause instanceof ControlError) return Response.json({ error: cause.message }, { status: cause.status });
  throw cause;
};

/** A parallel chat's proposal against the room: heads, ahead/behind and changed files; `?path=` for one file's diff. */
async function handleGET(request: Request, context: Context) {
  const gated = await gate(context);
  if (gated instanceof Response) return gated;
  const path = new URL(request.url).searchParams.get("path");
  try {
    if (path !== null) {
      if (!safeRelativePath(path)) return Response.json({ error: "Invalid file path." }, { status: 400 });
      const diff = await chatFileDiff(gated.runId, gated.sessionId, gated.result.user.id, path);
      return Response.json({ diff } satisfies ChatFileDiffResponse, { headers: { "cache-control": "no-store" } });
    }
    const state = await chatBranchState(gated.runId, gated.sessionId, gated.result.user.id);
    return Response.json(state satisfies ChatBranchResponse, { headers: { "cache-control": "no-store" } });
  } catch (cause) { return failure(cause); }
}

/** Merge into the room, update from the room, discard or reopen. Conflicts answer 409 with the files. */
async function handlePOST(request: Request, context: Context) {
  const gated = await gate(context);
  if (gated instanceof Response) return gated;
  if (!canWrite(gated.result.role)) return forbidden("Changing a chat's branch needs edit access to the room.");
  const body = await request.json().catch(() => null) as Partial<Record<string, unknown>> | null;
  const action = body?.action;
  const user = gated.result.user;
  const actor = { id: user.id, name: user.displayName, email: user.email };
  const heads = () => typeof body?.expectedChatHead === "string" && SHA.test(body.expectedChatHead) &&
    typeof body?.expectedRoomHead === "string" && SHA.test(body.expectedRoomHead)
    ? { expectedChatHead: body.expectedChatHead, expectedRoomHead: body.expectedRoomHead } : null;
  try {
    let outcome: ChatBranchActionResponse;
    if (action === "merge") {
      const expected = heads();
      if (!expected) return Response.json({ error: "Expected the chat and room heads you reviewed." }, { status: 400 });
      outcome = await mergeChatIntoRoom({ runId: gated.runId, sessionId: gated.sessionId, actor, ...expected });
    } else if (action === "update") {
      const expected = heads();
      if (!expected || !Number.isSafeInteger(body?.version)) return Response.json({ error: "Expected the chat and room heads and the control version." }, { status: 400 });
      outcome = await updateChatFromRoom({ runId: gated.runId, sessionId: gated.sessionId, actor, ...expected,
        version: body!.version as number, allowConflicts: body?.allowConflicts === true });
    } else if (action === "discard" || action === "reopen") {
      const { mergeState } = await setChatDiscarded({ runId: gated.runId, sessionId: gated.sessionId, actor, discarded: action === "discard" });
      outcome = { ok: true, mergeState };
    } else {
      return Response.json({ error: "Unknown action." }, { status: 400 });
    }
    return Response.json(outcome satisfies ChatBranchActionResponse, { status: outcome.ok ? 200 : 409 });
  } catch (cause) { return failure(cause); }
}

export const GET = withApiLimit("/api/sessions/[id]/runs/[runId]/branch", handleGET);
export const POST = withApiLimit("/api/sessions/[id]/runs/[runId]/branch", handlePOST);
