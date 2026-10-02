import { signupMode } from "../lib/auth/admission";
export const dynamic = "force-dynamic";
import { Suspense } from "react";
import { AuthForm } from "../components/auth/AuthForm";
import { SpinnerIcon } from "../components/icons";

export default function LoginPage() {
  return (
    <Suspense fallback={<main className="app-page grid min-h-dvh place-items-center"><p role="status" className="flex items-center gap-3 text-sm text-vs-muted"><SpinnerIcon className="h-5 w-5" /> Opening sign in…</p></main>}>
      <AuthForm signupMode={signupMode()} />
    </Suspense>
  );
}
