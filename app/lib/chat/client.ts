import { NotSignedIn } from "../session/client";
import type {
  ChatMessage,
  Conversation,
  ConversationResponse,
  ConversationsResponse,
  ConversationSummary,
  CreateConversationRequest,
  MessagesResponse,
} from "./types";
import type { ChatMessageEvent } from "../events/types";

async function readError(response: Response, fallback: string): Promise<string> {
  const body = (await response.json().catch(() => null)) as { error?: string } | null;
  return body?.error ?? fallback;
}

export async function listConversations(orgSlug: string): Promise<ConversationSummary[]> {
  const response = await fetch(`/api/chat/conversations?org=${encodeURIComponent(orgSlug)}`, {
    cache: "no-store",
  });
  if (response.status === 401) throw new NotSignedIn();
  if (!response.ok) throw new Error(await readError(response, "Could not load conversations."));
  return ((await response.json()) as ConversationsResponse).conversations;
}

export async function createConversation(
  input: CreateConversationRequest,
): Promise<Conversation> {
  const response = await fetch("/api/chat/conversations", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input),
  });
  if (response.status === 401) throw new NotSignedIn();
  if (!response.ok) throw new Error(await readError(response, "Could not start that conversation."));
  return ((await response.json()) as ConversationResponse).conversation;
}

export async function fetchConversation(id: string): Promise<Conversation> {
  const response = await fetch(`/api/chat/conversations/${encodeURIComponent(id)}`, {
    cache: "no-store",
  });
  if (response.status === 401) throw new NotSignedIn();
  if (!response.ok) throw new Error(await readError(response, "Could not open this conversation."));
  return ((await response.json()) as ConversationResponse).conversation;
}

export async function fetchChatMessages(
  conversationId: string,
  before?: string,
): Promise<MessagesResponse> {
  const base = `/api/chat/conversations/${encodeURIComponent(conversationId)}/messages`;
  const url = before ? `${base}?before=${encodeURIComponent(before)}` : base;

  const response = await fetch(url, { cache: "no-store" });
  if (response.status === 401) throw new NotSignedIn();
  if (!response.ok) throw new Error(await readError(response, "Could not load messages."));
  return (await response.json()) as MessagesResponse;
}

export async function sendChatMessage(
  conversationId: string,
  body: string,
): Promise<ChatMessage> {
  const response = await fetch(
    `/api/chat/conversations/${encodeURIComponent(conversationId)}/messages`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ body }),
    },
  );
  if (response.status === 401) throw new NotSignedIn();
  if (!response.ok) throw new Error(await readError(response, "Could not send that message."));
  return (await response.json()) as ChatMessage;
}

/** Best-effort: advance the read cursor. Failure is silent — it's a convenience,
 *  not something the UI should block on. */
export async function markConversationRead(conversationId: string): Promise<void> {
  await fetch(`/api/chat/conversations/${encodeURIComponent(conversationId)}/read`, {
    method: "POST",
  }).catch(() => {});
}

export type ChatStream = { close: () => void };

/**
 * Subscribes to a conversation's live stream. `EventSource` handles reconnection
 * itself, which is the main reason this is SSE rather than a socket.
 */
export function openChatStream(
  conversationId: string,
  options: {
    onMessage?: (event: ChatMessageEvent) => void;
    onStatus?: (connected: boolean) => void;
  },
): ChatStream {
  const source = new EventSource(
    `/api/chat/conversations/${encodeURIComponent(conversationId)}/events`,
  );

  source.addEventListener("ready", () => options.onStatus?.(true));
  source.onopen = () => options.onStatus?.(true);
  source.onerror = () => options.onStatus?.(false);

  source.addEventListener("chat.message", (message) => {
    try {
      const event = JSON.parse((message as MessageEvent).data as string) as ChatMessageEvent;
      if (event?.type === "chat.message") options.onMessage?.(event);
    } catch {
      // Ignore an unparseable frame.
    }
  });

  return {
    close() {
      source.close();
      options.onStatus?.(false);
    },
  };
}
