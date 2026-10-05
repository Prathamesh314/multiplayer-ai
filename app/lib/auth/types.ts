/** The signed-in user, as both the server and the browser see them. */
export type CurrentUser = {
  id: string;
  handle: string;
  email: string;
  displayName: string;
  avatarUrl: string | null;
};

export type RegisterRequest = {
  invitationToken?: string;
  handle?: string;
  email: string;
  displayName: string;
  password: string;
};

export type LoginRequest = {
  /** Handle or email — people remember one or the other. */
  identifier: string;
  password: string;
};

/** Email-first step one: the same form logs in or begins signup. */
export type ContinueRequest = { email: string; password: string; invitationToken?: string };

export type ContinueResponse =
  /** The email is known and the password matched — already signed in. */
  | { status: "existing"; user: CurrentUser; connectCode: string | null }
  | VerificationRequiredResponse
  /** The email is new; the password is acceptable. Complete registration next. */
  | { status: "new" };

export type MeResponse = {
  user: CurrentUser | null;
  /** The code others paste to add this person to an org. */
  connectCode: string | null;
};

export type EmailVerificationState = {
  serverTime: number;
  email: string;
  codeExpiresAt: number;
  resendAt: number;
  deliveryStatus: "pending" | "sent" | "failed";
};
export type VerificationRequiredResponse = { status: "verification_required"; verification: EmailVerificationState };
export type PasswordAuthResponse = { status: "authenticated"; user: CurrentUser; connectCode: string | null } | VerificationRequiredResponse;
