export type ChatShareRole = "viewer" | "commenter";
export type ChatInvitation = {
  id: string; email: string; role: ChatShareRole; createdAt: string;
  expiresAt: string; acceptedAt: string | null; revokedAt: string | null;
};
export type SharedMessage = {
  id: string; seq: number; role: "user" | "agent"; body: string;
  authorName: string | null; createdAt: string;
};
export type SharedComment = { id: string; body: string; authorName: string; createdAt: string };
export type SharedChat = {
  id: string; title: string; hostName: string; role: ChatShareRole | "manager";
  messages: SharedMessage[]; hasMore: boolean;
  comments: SharedComment[]; commentsHaveMore: boolean;
};
