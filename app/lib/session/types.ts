/** Session as the client is allowed to see it. */
export type Session = {
  id: string;
  name: string;
  /** Shareable code a new device must present to join. */
  joinCode: string;
  createdAt: number;
};

export type SessionListResponse = { sessions: Session[] };

export type CreateSessionRequest = { name?: string };

export type JoinSessionRequest = { code: string };
