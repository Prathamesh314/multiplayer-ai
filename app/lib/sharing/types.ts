export type ChatShareRole = "viewer" | "commenter";
export type ChatInvitation = {
  id: string; email: string; role: ChatShareRole; createdAt: string;
  /** Null for people added by email: access lasts until the host removes it. */
  expiresAt: string | null; acceptedAt: string | null; revokedAt: string | null;
  /** An earlier one-time invitation link rather than access by email. */
  viaLink?: boolean;
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
  workspacePath?: string;
  /** Signed out viewers come through "Anyone with the link" and must sign in to comment. */
  signedIn?: boolean;
  /** Access came only from the chat's link, not from being added by email. */
  viaLink?: boolean;
};
