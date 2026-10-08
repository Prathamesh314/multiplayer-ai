/** No automatic fallback to legacy passwords or application session cookies. */
export function clerkConfigured() {
  return !!process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY?.trim() && !!process.env.CLERK_SECRET_KEY?.trim();
}

export class ClerkAccountError extends Error {
  constructor(message: string, readonly status = 403) { super(message); }
}
