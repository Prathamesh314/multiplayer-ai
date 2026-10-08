import { clerkConfigured } from "../lib/auth/clerk-config";
import { AuthUnavailable } from "../components/auth/AuthForm";
import { AccountProfile } from "../components/auth/AccountProfile";
export const dynamic = "force-dynamic";
export default function AccountPage() { return clerkConfigured() ? <AccountProfile /> : <AuthUnavailable />; }
