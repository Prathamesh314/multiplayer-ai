export const providers = ["slack", "discord"] as const;
export type TeamProvider = (typeof providers)[number];
export const isProvider = (value: unknown): value is TeamProvider =>
  providers.includes(value as TeamProvider);
export type SourceChannel = { id: string; name: string; url: string };
export type SourceMessage = {
  id: string;
  channelId: string;
  authorId: string;
  authorName: string;
  body: string;
  url: string;
  sentAt: string;
  version: number;
  threadId?: string | null;
  deleted?: boolean;
};
export type Connection = {
  id: string;
  project_id: string;
  provider: TeamProvider;
  external_id: string;
  name: string;
  credential: string;
};
/** Ingestion adapters produce portable source records. AI/room code never calls
 * a chat vendor API. A later provider can implement the same contract. */
export interface TeamAdapter {
  authorize(state: string): string;
  exchange(
    code: string,
  ): Promise<{ externalId: string; name: string; token: string }>;
  channels(connection: Connection): Promise<SourceChannel[]>;
  history(
    connection: Connection,
    channel: SourceChannel,
  ): Promise<{ channel: SourceChannel; messages: SourceMessage[] }>;
}
export class IntegrationError extends Error {
  constructor(
    message: string,
    public status = 400,
    public retryAfter = 60,
  ) {
    super(message);
  }
}
