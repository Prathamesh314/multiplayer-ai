import { signupMode } from "../lib/auth/admission";
export const dynamic = "force-dynamic";
import { Suspense } from "react";
import { AuthForm } from "../components/auth/AuthForm";
import { SpinnerIcon } from "../components/icons";
import { googleConfigured } from "../lib/auth/google-provider";
import { googleCookie } from "../lib/auth/google-http";
import { emailVerificationCookie } from "../lib/auth/email-http";
import { pendingEmailVerification } from "../lib/auth/email-verification";
import { pendingGoogleProfile } from "../lib/auth/google-store";

export default async function LoginPage() {
  const googleEnabled = googleConfigured();
  const googleProfile = googleEnabled ? await pendingGoogleProfile(await googleCookie()) : null;
  const pendingVerification = await pendingEmailVerification(await emailVerificationCookie());
  return (
    <Suspense fallback={<main className="app-page grid min-h-dvh place-items-center"><p role="status" className="flex items-center gap-3 text-sm text-vs-muted"><SpinnerIcon className="h-5 w-5" /> Opening sign in…</p></main>}>
      <AuthForm signupMode={signupMode()} googleEnabled={googleEnabled} googleProfile={googleProfile} pendingVerification={pendingVerification} />
    </Suspense>
  );
}
