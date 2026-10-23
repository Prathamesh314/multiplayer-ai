import type { useClerk } from "@clerk/nextjs";
import { AuthRequestError, authRequest } from "./request";

type Clerk = ReturnType<typeof useClerk>;
export type DesktopSignInAttempt = {
  id: string;
  verifier: string;
  grant?: { ticket: string; userId: string };
  sessionId?: string;
};

/** Keep this state in memory for one approval. Both the approval and ticket are
 * single-use; an activation retry must resume the session they already created. */
export async function finishDesktopSignIn(
  attempt: DesktopSignInAttempt,
  clerk: Pick<Clerk, "client" | "setActive">,
  navigate: NonNullable<Parameters<Clerk["setActive"]>[0]["navigate"]>,
) {
  if (!clerk.client) throw new AuthRequestError("Sign-in is still loading. Please try again in a moment.");
  if (!attempt.grant) {
    attempt.grant = await authRequest("/api/auth/desktop/redeem", "POST", { id: attempt.id, verifier: attempt.verifier },
      (value): value is { ticket: string; userId: string } => {
        const grant = value as { ticket?: unknown; userId?: unknown } | null;
        return typeof grant?.ticket === "string" && !!grant.ticket && typeof grant.userId === "string" && !!grant.userId;
      });
  }
  let stage: "ticket" | "activation" = "ticket";
  try {
    // A previous attempt can have created a session even if its response or
    // activation failed. Refresh Clerk's client before spending another ticket.
    await clerk.client.reload();
    const session = clerk.client.sessions.find(session =>
      session.user?.id === attempt.grant!.userId && ["active", "pending"].includes(session.status) &&
      (!attempt.sessionId || session.id === attempt.sessionId));
    if (session) attempt.sessionId = session.id;
    else if (attempt.sessionId) {
      throw new AuthRequestError("Your desktop session ended. Select Start again and approve a new sign-in.");
    } else {
      // Use the returned resource: the shared sign-in resource can change when
      // Clerk updates its client. Capture the session ID before activating it.
      const result = await clerk.client.signIn.create({ strategy: "ticket", ticket: attempt.grant.ticket });
      if (result.status !== "complete" || !result.createdSessionId) {
        throw new AuthRequestError("Sign-in could not finish. Select Start again, or use the sign-in form below.");
      }
      attempt.sessionId = result.createdSessionId;
    }
    stage = "activation";
    const hasSession = () => clerk.client!.sessions.some(session => session.id === attempt.sessionId &&
      session.user?.id === attempt.grant!.userId && ["active", "pending"].includes(session.status));
    if (!hasSession()) await clerk.client.reload();
    if (!hasSession()) throw new Error("The created session is not available on this client yet.");
    await clerk.setActive({ session: attempt.sessionId, navigate });
  } catch (cause) {
    if (cause instanceof AuthRequestError) throw cause;
    // Do not display raw provider/transport errors (which can contain a token).
    const error = cause as { errors?: { code?: string }[]; code?: string } | null;
    const code = error?.errors?.[0]?.code ?? error?.code;
    if (code && /^(sign_in_token|ticket)_/.test(code)) {
      throw new AuthRequestError("This sign-in ticket expired or was already used. Select Start again and approve a new sign-in.");
    }
    if (code === "session_exists") {
      throw new AuthRequestError("Another account is signed in on this desktop. Sign out of that account, then start again.");
    }
    throw new AuthRequestError(stage === "activation"
      ? "Your browser approved sign-in, but the desktop session could not be activated. Check your connection and select Complete sign-in again."
      : "Could not connect to the sign-in service. Check your connection and select Complete sign-in again.");
  }
}
