import {
  createChannel,
  getOrCreateDm,
  isActiveOrgMember,
  listConversations,
  loadConversation,
} from "../../../lib/chat/store";
import type {
  ConversationResponse,
  ConversationsResponse,
  CreateConversationRequest,
} from "../../../lib/chat/types";
import { orgAccess, orgDenied } from "../../../lib/org/auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_NAME = 80;

/** The conversations the signed-in account can see in one org. */
export async function GET(request: Request) {
  const slug = new URL(request.url).searchParams.get("org");
  if (!slug) {
    return Response.json({ error: "An org is required." }, { status: 400 });
  }

  const result = await orgAccess(slug);
  const refusal = orgDenied(result);
  if (refusal || !result) return refusal!;

  const conversations = await listConversations(result.org.id, result.user.id);
  return Response.json({ conversations } satisfies ConversationsResponse, {
    headers: { "cache-control": "no-store" },
  });
}

/** Create a channel, or open (or reopen) a DM with another member. */
export async function POST(request: Request) {
  let payload: CreateConversationRequest;
  try {
    payload = (await request.json()) as CreateConversationRequest;
  } catch {
    return Response.json({ error: "Expected a JSON body." }, { status: 400 });
  }

  if (!payload || typeof payload.orgSlug !== "string") {
    return Response.json({ error: "An orgSlug is required." }, { status: 400 });
  }

  const result = await orgAccess(payload.orgSlug);
  const refusal = orgDenied(result);
  if (refusal || !result) return refusal!;

  if (payload.kind === "channel") {
    const name = typeof payload.name === "string" ? payload.name.trim() : "";
    if (name.length === 0) {
      return Response.json({ error: "Name the channel first." }, { status: 400 });
    }
    if (name.length > MAX_NAME) {
      return Response.json(
        { error: `Channel names are limited to ${MAX_NAME} characters.` },
        { status: 400 },
      );
    }
    const visibility = payload.visibility === "private" ? "private" : "public";
    const memberIds = Array.isArray(payload.memberIds)
      ? payload.memberIds.filter((m): m is string => typeof m === "string")
      : [];

    const id = await createChannel(result.org.id, result.user.id, name, visibility, memberIds);
    const conversation = await loadConversation(id, result.user.id);
    return Response.json({ conversation } as ConversationResponse, { status: 201 });
  }

  if (payload.kind === "dm") {
    const otherUserId = typeof payload.userId === "string" ? payload.userId : "";
    if (!otherUserId || otherUserId === result.user.id) {
      return Response.json({ error: "Pick someone to message." }, { status: 400 });
    }
    if (!(await isActiveOrgMember(result.org.id, otherUserId))) {
      return Response.json(
        { error: "That person isn't in this organisation." },
        { status: 400 },
      );
    }

    const id = await getOrCreateDm(result.org.id, result.user.id, otherUserId);
    const conversation = await loadConversation(id, result.user.id);
    return Response.json({ conversation } as ConversationResponse, { status: 201 });
  }

  return Response.json({ error: "Unknown conversation kind." }, { status: 400 });
}
