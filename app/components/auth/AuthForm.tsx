"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { useState } from "react";
import { continueWithEmail, register } from "../../lib/auth/client";
import { AlertIcon, EyeIcon, GitBranchIcon, SparkleIcon, SpinnerIcon, UsersIcon } from "../icons";

const MIN_PASSWORD_LENGTH = 10;

/** Step one collects email + password; step two only appears for new accounts. */
type Step = "email" | "username";

export function AuthForm() {
  const router = useRouter();
  const params = useSearchParams();
  // Only ever a path on this site: an open redirect here would let a share
  // link bounce someone to another origin after they type their password.
  const rawNext = params.get("next") ?? "/workspace";
  const next = rawNext.startsWith("/") && !rawNext.startsWith("//") ? rawNext : "/workspace";

  const [step, setStep] = useState<Step>("email");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [handle, setHandle] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

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
      const result = await continueWithEmail({ email: email.trim(), password });
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
    <main className="vs-scroll h-dvh overflow-y-auto bg-vs-editor text-vs-fg">
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
      <div className="mx-auto w-full max-w-md rounded-2xl border border-vs-border bg-vs-panel p-6 shadow-xl sm:p-8">
        <span className="flex items-center gap-2 text-base font-semibold">
          <SparkleIcon className="h-4 w-4 text-vs-accent" />
          <span className="whitespace-nowrap">
            multiplayer<span className="text-vs-muted">-ai</span>
          </span>
        </span>

        {step === "email" ? (
          <>
            <h1 className="font-display mt-6 text-[28px] font-semibold tracking-tight">
              Your team starts here
            </h1>
            <p className="mt-2 text-[14px] leading-6 text-vs-muted">
              Enter your email and password. We&apos;ll sign you in, or start a new account if this
              is your first time.
            </p>

            <form onSubmit={submitEmail} className="mt-6 space-y-3">
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

            <form onSubmit={submitUsername} className="mt-6 space-y-3">
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

        <p className="mt-5 text-center text-[12px] leading-5 text-vs-muted">
          New accounts need a password of at least {MIN_PASSWORD_LENGTH} characters.
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
      className="absolute right-1 top-1/2 -translate-y-1/2 rounded p-2 text-vs-muted transition hover:bg-vs-hover hover:text-vs-fg focus-visible:outline focus-visible:outline-2 focus-visible:outline-vs-accent"
    >
      <EyeIcon off={shown} className="h-4 w-4" />
    </button>
  );
}

function SubmitButton({ busy, children }: { busy: boolean; children: React.ReactNode }) {
  return (
    <button
      type="submit"
      disabled={busy}
      className="flex w-full items-center justify-center gap-2 rounded-lg bg-vs-accent px-4 py-2.5 text-base font-medium text-vs-accent-fg transition hover:opacity-90 disabled:opacity-60"
    >
      {busy && <SpinnerIcon className="h-4 w-4" />}
      {children}
    </button>
  );
}

function ErrorNote({ children }: { children: React.ReactNode }) {
  return (
    <p role="alert" className="flex items-start gap-2 rounded-lg border border-vs-danger/40 bg-vs-danger/10 px-3 py-2 text-sm leading-5 text-vs-danger">
      <AlertIcon className="mt-0.5 h-3.5 w-3.5 shrink-0" />
      {children}
    </p>
  );
}

const inputClass =
  "mt-1.5 w-full rounded-lg border border-vs-border bg-vs-panel px-3 py-2 text-base text-vs-fg outline-none placeholder:text-vs-muted focus:border-vs-accent";

function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <label className="block">
      <span className="text-[12px] font-semibold uppercase tracking-wider text-vs-muted">
        {label}
      </span>
      {children}
      {hint && <span className="mt-1 block text-[12px] text-vs-muted">{hint}</span>}
    </label>
  );
}
