export type Checkpoint = {
  id: string; turnId: string; sequence: number; baseSha: string; headSha: string;
  indexSha: string; snapshotSha: string; capturedAt: string;
};
export const checkpointRef = (snapshot: Pick<Checkpoint, "turnId" | "sequence">) => `refs/checkpoints/${snapshot.turnId}/${snapshot.sequence}`;
