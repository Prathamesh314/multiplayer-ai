/** The signed-in user, as both the server and the browser see them. */
export type CurrentUser = {
  id: string;
  handle: string;
  email: string;
  displayName: string;
  avatarUrl: string | null;
};

export type RegisterRequest = {
  handle: string;
  email: string;
  displayName: string;
  password: string;
};

export type LoginRequest = {
  /** Handle or email — people remember one or the other. */
  identifier: string;
  password: string;
};

export type MeResponse = {
  user: CurrentUser | null;
  /** The code others paste to add this person to an org. */
  connectCode: string | null;
};
