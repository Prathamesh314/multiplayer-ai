"use client";
import { ExecutionRequirements } from "../ai/ExecutionRequirements";

import Link from "next/link";
import { Field, ErrorNote, inputClass } from "../ui/Modal";
import { useRouter, useSearchParams } from "next/navigation";
import { useEffect, useState, useSyncExternalStore } from "react";
import { login, register } from "../../lib/auth/client";
import { invitationDetails } from "../../lib/auth/invitation-link";
import { safeReturnPath } from "../../lib/auth/return-path";
import { EyeIcon, GitBranchIcon, SparkleIcon, SpinnerIcon, UsersIcon } from "../icons";
import { EmailVerification } from "./EmailVerification";
import { AuthRequestError, authErrorMessage } from "../../lib/auth/request";
import { useToast } from "../ui/Toast";
import type { EmailVerificationState } from "../../lib/auth/types";
import { GoogleCompletion, GoogleSignIn, type PendingGoogleProfile } from "./GoogleAuth";

const MIN_PASSWORD_LENGTH = 10;
const subscribeToHydration = () => () => {};
const clientReady = () => true;
const serverReady = () => false;

export function AuthForm({ signupMode = "open", googleEnabled = false, googleProfile = null, pendingVerification = null }: {
  signupMode?: "open" | "invite" | "closed"; googleEnabled?: boolean; googleProfile?: PendingGoogleProfile | null; pendingVerification?: EmailVerificationState | null;
}) {
  const router = useRouter();
  const { notify } = useToast();
  const [retrySeconds, setRetrySeconds] = useState(0);
  useEffect(() => {
    if (!retrySeconds) return;
    const timer = setTimeout(() => setRetrySeconds(value => Math.max(0, value - 1)), 1000);
    return () => clearTimeout(timer);
  }, [retrySeconds]);
  const params = useSearchParams();
  // Only ever a path on this site: an open redirect here would let a share
  // link bounce someone to another origin after they type their password.
  const next = safeReturnPath(params.get("next"));

  const linkedInvitation = params.get("invite") ?? /^\/invite\/([a-zA-Z0-9_-]{43})$/.exec(next)?.[1] ?? "";
  const [pastedInvitation, setPastedInvitation] = useState<{ source: string; value: string } | null>(null);
  const invitationInput = pastedInvitation?.source === linkedInvitation ? pastedInvitation.value : linkedInvitation;
  // A malformed value is still sent to the server: an existing account can
  // sign in without an invitation, even when arriving through an old link.
  const invitationToken = invitationDetails(invitationInput)?.token ?? (invitationInput.trim() || undefined);

  const [mode, setMode] = useState<"signin" | "signup">(() => signupMode !== "closed" && (params.get("mode") === "signup" || linkedInvitation) ? "signup" : "signin");
  const creating = mode === "signup";
  const [verification, setVerification] = useState(pendingVerification);
  const [email, setEmail] = useState(() => params.get("email") ?? "");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(() => {
    const reason = params.get("google_error");
    return reason === "cancelled" ? "Google sign-in was cancelled. You can try again." : reason === "expired" ? "Google sign-in expired or was already used. Please start again." : reason === "failed" ? "Google sign-in could not be completed. Please try again." : null;
  });

  function done() {
    router.push(next);
    router.refresh();
  }

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (busy || retrySeconds > 0) return;
    setBusy(true);
    setError(null);
    setShowPassword(false);
    try {
      const result = creating
        ? await register({ email: email.trim(), password, displayName: "", invitationToken })
        : await login(email.trim(), password);
      if (result.status === "verification_required") {
        setVerification(result.verification); setPassword(""); setBusy(false);
        if (result.verification.deliveryStatus === "sent") notify({ title: "Check your email", description: "Your verification code is on its way. Check spam if it doesn’t arrive." });
        else if (result.verification.deliveryStatus === "failed") notify({ tone: "error", title: "We couldn’t send your code", description: "Your account is waiting for verification. Try sending a new code shortly." });
        return;
      }
      notify({ title: creating ? "Account created" : "Welcome back", description: "You’re signed in." });
      done();
    } catch (cause) {
      const message = authErrorMessage(cause, "Could not complete sign-in. Please try again.");
      setError(message);
      if (cause instanceof AuthRequestError && cause.retryAfter) setRetrySeconds(cause.retryAfter);
      notify({ tone: "error", title: creating ? "Couldn’t create your account" : "Couldn’t sign you in", description: message });
      setBusy(false);
    }
  }

  return (
    <main className="app-page vs-scroll h-dvh overflow-y-auto bg-vs-editor text-vs-fg">
      <div className="mx-auto grid min-h-full max-w-6xl items-center gap-12 px-6 py-10 sm:px-10 lg:grid-cols-[1.2fr_1fr] lg:gap-20">
      <section className="hidden lg:block" aria-label="About multiplayer-ai">
        <p className="text-xs font-medium uppercase tracking-[0.2em] text-vs-muted">A workspace for humans and agents</p>
        <h2 className="font-display mt-6 max-w-xl text-6xl font-semibold leading-[1.08] tracking-tight">Great software is a team effort.</h2>
        <p className="mt-6 max-w-md text-lg leading-8 text-vs-muted">Give your team and AI a shared place to build, learn from each other, and move work forward.</p>
        <div className="workspace-welcome mt-10 space-y-6 rounded-2xl border border-vs-border p-6">
          {[
            { icon: UsersIcon, title: "Bring everyone into the work", body: "Shared rooms, team channels, and conversations you can continue." },
            { icon: SparkleIcon, title: "Keep useful context close", body: "Reference a teammate’s AI chat without explaining everything again." },
            { icon: GitBranchIcon, title: "Build on your own branch", body: "Review your changes before publishing them to the project." },
          ].map(({ icon: Icon, title, body }) => (
            <div key={title} className="flex gap-4"><Icon className="mt-1 h-5 w-5 shrink-0 text-vs-muted" /><div><p className="text-sm font-medium">{title}</p><p className="mt-1 text-sm leading-6 text-vs-muted">{body}</p></div></div>
          ))}
        </div>
      </section>
      <div className="mx-auto w-full max-w-md rounded-3xl border border-vs-border bg-vs-panel p-6 shadow-[0_24px_80px_-24px_var(--vs-shadow)] sm:p-9">
        <Link href="/" className="inline-flex items-center gap-2 rounded-lg text-base font-semibold" aria-label="Multiplayer AI home">
          <SparkleIcon className="h-4 w-4 text-vs-accent" />
          <span className="whitespace-nowrap">
            multiplayer<span className="text-vs-muted">-ai</span>
          </span>
        </Link>

        {!!googleProfile && params.get("google") !== "restart" && params.get("google") !== "desktop-done" && <ExecutionRequirements guest={next.startsWith("/shared/")} className="mt-5" />}

        {params.get("google") === "desktop-done" ? <div className="mt-6 space-y-4"><h1 className="font-display text-[28px] font-semibold">You’re ready to sign in</h1><p className="text-sm leading-6 text-vs-muted">Return to Multiplayer AI and click <strong className="text-vs-fg">Complete sign-in</strong>. You can then close this browser tab.</p></div> : googleProfile && params.get("google") !== "restart" ? <GoogleCompletion profile={googleProfile} signupMode={signupMode} /> : verification ? (
          <EmailVerification initial={verification} onVerified={done} onBack={address => { setVerification(null); setEmail(address); setMode("signin"); setError(null); }} />
        ) : (
          <>
            <h1 className="font-display mt-6 text-[28px] font-semibold tracking-tight">
              {creating ? "Create your account" : "Welcome back"}
            </h1>
            <p className="mt-2 text-[14px] leading-6 text-vs-muted">
              {creating ? (signupMode === "invite" ? "Use your invited email and choose a password." : "Start building with your team and AI.") : "Sign in to your workspace."}
            </p>

            {(creating || googleEnabled) && <ExecutionRequirements guest={next.startsWith("/shared/")} className="mt-5" />}
            {googleEnabled && <GoogleSignIn next={next} invitationToken={invitationToken} desktopId={params.get("desktop")} />}

            <form onSubmit={submit} className="mt-7 space-y-5">
              <Field label="Email">
                <input
                  autoFocus={!creating && !googleEnabled}
                  required
                  type="email"
                  value={email}
                  onChange={(event) => setEmail(event.target.value)}
                  placeholder="you@example.com"
                  autoComplete="email"
                  className={inputClass}
                />
              </Field>

              <Field label="Password" hint={creating ? `At least ${MIN_PASSWORD_LENGTH} characters.` : undefined}>
                <div className="relative">
                  <input
                    required
                    type={showPassword ? "text" : "password"}
                    value={password}
                    onChange={(event) => setPassword(event.target.value)}
                    autoComplete={creating ? "new-password" : "current-password"}
                    minLength={creating ? MIN_PASSWORD_LENGTH : undefined}
                    className={`${inputClass} pr-10`}
                  />
                  <PasswordToggle shown={showPassword} onToggle={() => setShowPassword((s) => !s)} />
                </div>
              </Field>

              {error && <ErrorNote announce={!!params.get("google_error")}>{error}</ErrorNote>}

              {creating && signupMode === "invite" && (
                <Field label="Invitation link or code" hint="Paste the newest invitation and use the email it was issued to.">
                  <input
                    type="text"
                    value={invitationInput}
                    onChange={(event) => {
                      const value = event.target.value;
                      setPastedInvitation({ source: linkedInvitation, value });
                      const invitedEmail = invitationDetails(value)?.email;
                      if (invitedEmail) setEmail(invitedEmail);
                      setError(null);
                    }}
                    placeholder="Paste your invitation link or code"
                    autoComplete="off"
                    autoCapitalize="none"
                    spellCheck={false}
                    className={inputClass}
                  />
                </Field>
              )}

              <SubmitButton busy={busy} blocked={retrySeconds > 0}>{busy ? (creating ? "Creating account…" : "Signing in…") : retrySeconds > 0 ? `Try again in ${retrySeconds}s` : creating ? "Create account" : "Sign in"}</SubmitButton>
            </form>
          </>
        )}

        {!verification && (!googleProfile || params.get("google") === "restart") && params.get("google") !== "desktop-done" && (
          <p className="mt-6 text-center text-sm leading-6 text-vs-muted">
            {creating ? "Already have an account? " : signupMode === "closed" ? "New registrations are currently closed." : "New here? "}
            {(creating || signupMode !== "closed") && <button
              type="button"
              disabled={busy}
              onClick={() => { setMode(creating ? "signin" : "signup"); setError(null); }}
              className="rounded font-medium text-vs-fg underline-offset-4 hover:underline disabled:opacity-60"
            >{creating ? "Sign in" : "Create an account"}</button>}
          </p>
        )}
      </div>
      </div>
    </main>
  );
}

function PasswordToggle({ shown, onToggle }: { shown: boolean; onToggle: () => void }) {
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-label={shown ? "Hide password" : "Show password"}
      aria-pressed={shown}
      // Keeps focus in the field, so toggling mid-typing does not move the caret.
      onMouseDown={(event) => event.preventDefault()}
      className="absolute right-1 top-1/2 -translate-y-1/2 rounded p-2 text-vs-muted transition hover:bg-vs-hover hover:text-vs-fg"
    >
      <EyeIcon off={shown} className="h-4 w-4" />
    </button>
  );
}

function SubmitButton({ busy, blocked, children }: { busy: boolean; blocked: boolean; children: React.ReactNode }) {
  // Before hydration, a native GET form submission strips the invitation from
  // the URL. Keep submission disabled until React can handle the form.
  const ready = useSyncExternalStore(subscribeToHydration, clientReady, serverReady);
  return (
    <button
      type="submit"
      disabled={busy || blocked || !ready}
      className="flex w-full items-center justify-center gap-2 rounded-lg bg-vs-accent px-4 py-2.5 text-base font-medium text-vs-accent-fg transition hover:opacity-90 disabled:opacity-60"
    >
      {busy && <SpinnerIcon className="h-4 w-4" />}
      {ready ? children : "Loading sign in…"}
    </button>
  );
}
