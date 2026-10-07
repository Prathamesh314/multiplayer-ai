export const briefingFields = ["goal", "decisions", "progress", "blockers", "nextAction"] as const;
export type BriefingField = typeof briefingFields[number];
export type BriefingBody = Record<BriefingField, string>;
export type BriefingSource = { kind: "message" | "memory" | "commit" | "task"; id: string; label: string; excerpt: string };
export type Briefing = {
  body: BriefingBody; sources: BriefingSource[]; fingerprint: string;
  sourceSeq: number; headSha: string | null; revision: number;
  sharedWithGuests: boolean; stale: boolean; canEdit: boolean; canPublish: boolean;
  updatedBy: string | null; updatedAt: string | null;
};
export type ChatReview = {
  id: string; runId: string; reviewerId: string; reviewerName: string;
  requestedBy: string; requesterName: string; headSha: string; baseSha: string;
  status: "requested" | "approved" | "changes_requested" | "cancelled";
  requestNote: string; responseNote: string; createdAt: string; resolvedAt: string | null;
  stale: boolean;
};
export type FeedbackComment = { id: string; seq: number; body: string; authorName: string; createdAt: string };
export type Feedback = { comments: FeedbackComment[]; hasMore: boolean; lastRead: number; canComment: boolean };
export type InboxItem = { runId: string; sessionId: string; title: string; unread: number; reviews: number };
export type AccessPreview = {
  invitationId: string; email: string; userId: string | null; canGrant: boolean;
  reason: string | null; scope: string[]; alreadyEditor: boolean; sessionId: string;
  scopeKey: string; canRequest: boolean; requestPending: boolean;
};
export type AccessRequest = {runId:string;invitationId:string;email:string;requesterName:string;projectName:string};
