export const taskStatuses = ["open", "in_progress", "done", "cancelled"] as const;
export type TaskStatus = typeof taskStatuses[number];
export type TaskMember = { userId: string; handle: string; displayName: string };
export type RoomTask = {
  id: string; runId: string; sessionId: string; roomName: string; chatTitle: string;
  createdBy: string; creatorName: string; assigneeId: string; assigneeName: string;
  assigneeHandle: string; body: string; status: TaskStatus; createdAt: string;
};
export const isUUID = (value: unknown): value is string => typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
