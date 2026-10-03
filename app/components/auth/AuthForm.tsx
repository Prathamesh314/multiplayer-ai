"use client";

import Link from "next/link";
import { Field, ErrorNote, inputClass } from "../ui/Modal";
import { useRouter, useSearchParams } from "next/navigation";
import { useState, useSyncExternalStore } from "react";
import { continueWithEmail, register } from "../../lib/auth/client";
import { invitationDetails } from "../../lib/auth/invitation-link";
import { safeReturnPath } from "../../lib/auth/return-path";
import { EyeIcon, GitBranchIcon, SparkleIcon, SpinnerIcon, UsersIcon } from "../icons";
import { GoogleCompletion, GoogleSignIn, type PendingGoogleProfile } from "./GoogleAuth";

const MIN_PASSWORD_LENGTH = 10;
const subscribeToHydration = () => () => {};
const clientReady = () => true;
const serverReady = () => false;

/** Step one collects email + password; step two only appears for new accounts. */
type Step = "email" | "username";

export function AuthForm({ signupMode = "open", googleEnabled = false, googleProfile = null }: {
  signupMode?: "open" | "invite" | "closed"; googleEnabled?: boolean; googleProfile?: PendingGoogleProfile | null;
}) {
  const router = useRouter();
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

  const [step, setStep] = useState<Step>("email");
  const [email, setEmail] = useState(() => params.get("email") ?? "");
  const [password, setPassword] = useState("");
  const [handle, setHandle] = useState("");
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

  async function submitEmail(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    setShowPassword(false);
    try {
      const result = await continueWithEmail({ email: email.trim(), password, invitationToken });
      if (result.status === "existing") {
        done();
        return;
      }
      // New email, valid password — move on to pick a username.
      setStep("username");
      setBusy(false);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Something went wrong.");
      setBusy(false);
    }
  }

  async function submitUsername(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await register({
        invitationToken,
        handle: handle.trim(),
        email: email.trim(),
        displayName: handle.trim(),
        password,
      });
      done();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not create your account.");
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

        {params.get("google") === "desktop-done" ? <div className="mt-6 space-y-4"><h1 className="font-display text-[28px] font-semibold">You’re ready to sign in</h1><p className="text-sm leading-6 text-vs-muted">Return to Multiplayer AI and click <strong className="text-vs-fg">Complete sign-in</strong>. You can then close this browser tab.</p></div> : googleProfile && params.get("google") !== "restart" ? <GoogleCompletion profile={googleProfile} signupMode={signupMode} /> : step === "email" ? (
          <>
            <h1 className="font-display mt-6 text-[28px] font-semibold tracking-tight">
              Your team starts here
            </h1>
            <p className="mt-2 text-[14px] leading-6 text-vs-muted">
              {signupMode === "open" ? "Enter your email and password to sign in or create an account." : signupMode === "closed" ? "Sign in to your existing account. New registrations are currently closed." : invitationToken ? "Sign in or create an account using the email your invitation was sent to." : "Sign in to your account. To join the beta, open the invitation link from your team administrator."}
            </p>

            {googleEnabled && <GoogleSignIn next={next} invitationToken={invitationToken} desktopId={params.get("desktop")} />}

            <form onSubmit={submitEmail} className="mt-7 space-y-5">
              <Field label="Email">
                <input
                  autoFocus
                  required
                  type="email"
                  value={email}
                  onChange={(event) => setEmail(event.target.value)}
                  placeholder="you@example.com"
                  autoComplete="email"
                  className={inputClass}
                />
              </Field>

              <Field label="Password">
                <div className="relative">
                  <input
                    required
                    type={showPassword ? "text" : "password"}
                    value={password}
                    onChange={(event) => setPassword(event.target.value)}
                    autoComplete="current-password"
                    className={`${inputClass} pr-10`}
                  />
                  <PasswordToggle shown={showPassword} onToggle={() => setShowPassword((s) => !s)} />
                </div>
              </Field>

              {error && <ErrorNote>{error}</ErrorNote>}

              {signupMode === "invite" && (
                <Field label="Invitation link or code" hint="Required only when creating a new account. Paste the newest invitation and use the email it was issued to.">
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

              <SubmitButton busy={busy}>Continue</SubmitButton>
            </form>
          </>
        ) : (
          <>
            <h1 className="font-display mt-6 text-[28px] font-semibold tracking-tight">
              Pick a username
            </h1>
            <p className="mt-2 text-[14px] leading-6 text-vs-muted">
              Almost there — choose a username for{" "}
              <span className="text-vs-fg">{email.trim()}</span>. It&apos;s how teammates will see
              you.
            </p>

            <form onSubmit={submitUsername} className="mt-7 space-y-5">
              <Field label="Username" hint="Lowercase letters, numbers, dashes.">
                <input
                  autoFocus
                  required
                  value={handle}
                  onChange={(event) => setHandle(event.target.value.toLowerCase())}
                  placeholder="prathamesh"
                  autoComplete="username"
                  className={inputClass}
                />
              </Field>

              {error && <ErrorNote>{error}</ErrorNote>}

              <SubmitButton busy={busy}>Create account &amp; enter</SubmitButton>

              <button
                type="button"
                onClick={() => {
                  setStep("email");
                  setError(null);
                }}
                className="w-full text-center text-sm text-vs-muted underline-offset-2 hover:text-vs-fg hover:underline"
              >
                Use a different email
              </button>
            </form>
          </>
        )}

        <p className="mt-6 text-center text-[13px] leading-5 text-vs-muted">
          {googleProfile || params.get("google") === "desktop-done" ? "Your Google password is never shared with Multiplayer AI." : `Email signups need a password of at least ${MIN_PASSWORD_LENGTH} characters.`}
        </p>
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

function SubmitButton({ busy, children }: { busy: boolean; children: React.ReactNode }) {
  // Before hydration, a native GET form submission strips the invitation from
  // the URL. Keep submission disabled until React can handle the form.
  const ready = useSyncExternalStore(subscribeToHydration, clientReady, serverReady);
  return (
    <button
      type="submit"
      disabled={busy || !ready}
      className="flex w-full items-center justify-center gap-2 rounded-lg bg-vs-accent px-4 py-2.5 text-base font-medium text-vs-accent-fg transition hover:opacity-90 disabled:opacity-60"
    >
      {busy && <SpinnerIcon className="h-4 w-4" />}
      {ready ? children : "Loading sign in…"}
    </button>
  );
}
