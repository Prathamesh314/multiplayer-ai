"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { useState } from "react";
import { login, register } from "../../lib/auth/client";
import { AlertIcon, EyeIcon, SparkleIcon, SpinnerIcon } from "../icons";

type Mode = "signin" | "register";

const MIN_PASSWORD_LENGTH = 10;

export function AuthForm() {
  const router = useRouter();
  const params = useSearchParams();
  // Only ever a path on this site: an open redirect here would let a share
  // link bounce someone to another origin after they type their password.
  const rawNext = params.get("next") ?? "/";
  const next = rawNext.startsWith("/") && !rawNext.startsWith("//") ? rawNext : "/";

  const [mode, setMode] = useState<Mode>("signin");
  const [identifier, setIdentifier] = useState("");
  const [handle, setHandle] = useState("");
  const [email, setEmail] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      setShowPassword(false);
      if (mode === "signin") await login(identifier, password);
      else await register({ handle, email, displayName, password });
      router.push(next);
      router.refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Something went wrong.");
      setBusy(false);
    }
  }

  const registering = mode === "register";

  return (
    <div className="flex min-h-dvh items-center justify-center bg-vs-editor px-6 py-12 text-vs-fg">
      <div className="w-full max-w-sm">
        <span className="flex items-center gap-2 text-sm font-semibold">
          <SparkleIcon className="h-4 w-4 text-vs-accent" />
          <span className="whitespace-nowrap">
            multiplayer<span className="text-vs-muted">-ai</span>
          </span>
        </span>

        <h1 className="mt-6 text-2xl font-semibold tracking-tight">
          {registering ? "Create an account" : "Sign in"}
        </h1>
        <p className="mt-1.5 text-xs leading-5 text-vs-muted">
          {next !== "/"
            ? "You need an account to open a shared session."
            : "Sessions and the code in them belong to an account."}
        </p>

        <form onSubmit={submit} className="mt-6 space-y-3">
          {registering ? (
            <>
              <Field label="Handle" hint="Lowercase letters, numbers, dashes.">
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
              <Field label="Email">
                <input
                  required
                  type="email"
                  value={email}
                  onChange={(event) => setEmail(event.target.value)}
                  placeholder="you@example.com"
                  autoComplete="email"
                  className={inputClass}
                />
              </Field>
              <Field label="Display name">
                <input
                  value={displayName}
                  onChange={(event) => setDisplayName(event.target.value)}
                  placeholder="Prathamesh"
                  autoComplete="name"
                  className={inputClass}
                />
              </Field>
            </>
          ) : (
            <Field label="Handle or email">
              <input
                autoFocus
                required
                value={identifier}
                onChange={(event) => setIdentifier(event.target.value)}
                placeholder="prathamesh"
                autoComplete="username"
                className={inputClass}
              />
            </Field>
          )}

          <Field
            label="Password"
            hint={registering ? `At least ${MIN_PASSWORD_LENGTH} characters.` : undefined}
          >
            <div className="relative">
              <input
                required
                type={showPassword ? "text" : "password"}
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                minLength={registering ? MIN_PASSWORD_LENGTH : undefined}
                autoComplete={registering ? "new-password" : "current-password"}
                // Room on the right so a long password never runs under the button.
                className={`${inputClass} pr-10`}
              />
              <button
                type="button"
                onClick={() => setShowPassword((shown) => !shown)}
                // Labelled by what pressing it does, not by what is on screen.
                aria-label={showPassword ? "Hide password" : "Show password"}
                aria-pressed={showPassword}
                // Keeps focus in the field, so toggling mid-typing does not
                // move the caret or dismiss the keyboard on a phone.
                onMouseDown={(event) => event.preventDefault()}
                className="absolute right-1 top-1/2 -translate-y-1/2 rounded p-2 text-vs-muted transition hover:bg-vs-hover hover:text-vs-fg focus-visible:outline focus-visible:outline-2 focus-visible:outline-vs-accent"
              >
                <EyeIcon off={showPassword} className="h-4 w-4" />
              </button>
            </div>
          </Field>

          {error && (
            <p className="flex items-start gap-2 rounded-lg border border-red-500/40 bg-red-500/10 px-3 py-2 text-xs leading-5 text-red-600 dark:text-red-300">
              <AlertIcon className="mt-0.5 h-3.5 w-3.5 shrink-0" />
              {error}
            </p>
          )}

          <button
            type="submit"
            disabled={busy}
            className="flex w-full items-center justify-center gap-2 rounded-lg bg-vs-accent px-4 py-2.5 text-sm font-medium text-vs-accent-fg transition hover:opacity-90 disabled:opacity-60"
          >
            {busy && <SpinnerIcon className="h-4 w-4" />}
            {registering ? "Create account" : "Sign in"}
          </button>
        </form>

        <p className="mt-5 text-center text-xs text-vs-muted">
          {registering ? "Already have an account?" : "No account yet?"}{" "}
          <button
            type="button"
            onClick={() => {
              setMode(registering ? "signin" : "register");
              setShowPassword(false);
              setError(null);
            }}
            className="text-vs-accent underline-offset-2 hover:underline"
          >
            {registering ? "Sign in" : "Create one"}
          </button>
        </p>
      </div>
    </div>
  );
}

const inputClass =
  "mt-1.5 w-full rounded-lg border border-vs-border bg-vs-panel px-3 py-2 text-sm text-vs-fg outline-none placeholder:text-vs-muted focus:border-vs-accent";

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
      <span className="text-[11px] font-semibold uppercase tracking-wider text-vs-muted">
        {label}
      </span>
      {children}
      {hint && <span className="mt-1 block text-[11px] text-vs-muted">{hint}</span>}
    </label>
  );
}
