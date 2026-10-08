import { Suspense } from "react";
import { clerkConfigured } from "../../lib/auth/clerk-config";
import { AuthUnavailable } from "../../components/auth/AuthForm";
import { CompleteSignIn } from "../../components/auth/CompleteSignIn";
export const dynamic = "force-dynamic";
export default function CompletePage() {
  return clerkConfigured() ? <Suspense><CompleteSignIn /></Suspense> : <AuthUnavailable />;
}
