import { withApiLimit } from "../../../../lib/http/api-limit";
import { retiredAuth } from "../../../../lib/auth/clerk-http";
export const DELETE = withApiLimit("/api/auth/email/pending", retiredAuth);
