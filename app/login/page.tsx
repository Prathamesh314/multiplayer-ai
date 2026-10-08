import { Suspense } from "react";
import { signupMode } from "../lib/auth/admission";
import { clerkConfigured } from "../lib/auth/clerk-config";
import { AuthForm, AuthUnavailable } from "../components/auth/AuthForm";
export const dynamic = "force-dynamic";
export default function LoginPage() {
  if (!clerkConfigured()) return <AuthUnavailable />;
  return <Suspense><AuthForm signupMode={signupMode()} /></Suspense>;
}
