import { withApiLimit } from "../../../../lib/http/api-limit";
import { retiredAuth } from "../../../../lib/auth/clerk-http";

export const GET = withApiLimit("/api/auth/google/start", retiredAuth);
