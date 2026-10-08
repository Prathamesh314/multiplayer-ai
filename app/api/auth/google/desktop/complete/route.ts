import { withApiLimit } from "../../../../../lib/http/api-limit";
import { retiredAuth } from "../../../../../lib/auth/clerk-http";

export const POST = withApiLimit("/api/auth/google/desktop/complete", retiredAuth);
