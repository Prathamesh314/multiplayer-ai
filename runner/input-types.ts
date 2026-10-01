export type QueuedInput = { id: string; body: string };
export type InputSource = {
  /** Atomically close intake if empty at an agent boundary. */
  claim(closeIfEmpty?: boolean): Promise<QueuedInput | null>;
  acknowledge(id: string): Promise<void>;
  /** Delivery may already have happened: never silently replay it. */
  uncertain(id: string, message: string): Promise<void>;
  subscribe(wake: () => void): () => void;
};
