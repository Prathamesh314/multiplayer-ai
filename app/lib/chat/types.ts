/** Team-chat shapes as the client is allowed to see them. Mirrors the session
 *  chat types, but scoped to an org's channels and direct messages rather than
 *  to a single room. */

export type ConversationKind = "channel" | "dm";
export type ConversationVisibility = "public" | "private";
export type ConversationRole = "owner" | "member";

/** One conversation as a chat message is stored and returned. */
export type ChatMessage = {
  id: string;
  userId: string;
  userName: string;
  handle: string;
  body: string;
  createdAt: number;
};

/** A person on a conversation's roster. */
export type ConversationMember = {
  userId: string;
  handle: string;
  displayName: string;
  avatarUrl: string | null;
  role: ConversationRole;
};

/** A row in the chat sidebar list. */
export type ConversationSummary = {
  id: string;
  kind: ConversationKind;
  /** Channel name, or the other member's display name for a DM. */
  name: string;
  visibility: ConversationVisibility;
  /** Unread messages from other people since this account last read it. */
  unread: number;
  lastMessageAt: number | null;
  lastPreview: { body: string; author: string; at: number } | null;
  /** For a DM, the other participant's user id (for a stable avatar colour). */
  otherUserId: string | null;
};

/** The full conversation, for the open pane. */
export type Conversation = {
  id: string;
  orgId: string;
  kind: ConversationKind;
  name: string;
  topic: string | null;
  visibility: ConversationVisibility;
  otherUserId: string | null;
  members: ConversationMember[];
  /** This account's explicit role, or null for a public channel it hasn't joined. */
  myRole: ConversationRole | null;
};

export type ConversationsResponse = { conversations: ConversationSummary[] };
export type ConversationResponse = { conversation: Conversation };
export type MessagesResponse = { messages: ChatMessage[]; hasMore: boolean };
export type SendMessageRequest = { body: string };

export type CreateConversationRequest =
  | {
      orgSlug: string;
      kind: "channel";
      name: string;
      visibility?: ConversationVisibility;
      /** For a private channel, the org members to seed it with. */
      memberIds?: string[];
    }
  | { orgSlug: string; kind: "dm"; userId: string };
