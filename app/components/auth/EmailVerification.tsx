"use client";

import { useEffect, useRef, useState } from "react";
import { isPasswordAuthResponse, isVerificationState, type EmailVerificationState } from "../../lib/auth/types";
import { AuthRequestError, authErrorMessage, authRequest } from "../../lib/auth/request";
import { ErrorNote, Field, inputClass } from "../ui/Modal";
import { useToast } from "../ui/Toast";
import { CheckIcon, SpinnerIcon } from "../icons";

const deliveryError = "We couldn’t send your code. Your account still needs verification. Please try sending a new code shortly.";
const countdown = (seconds: number) => seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;

export function EmailVerification({ initial, onVerified, onBack }: {
  initial: EmailVerificationState; onVerified: () => void; onBack: (email: string) => void;
}) {
  const { notify } = useToast();
  const [verification, setVerification] = useState(initial);
  const [now, setNow] = useState(initial.serverTime);
  const clock = useRef({ server: initial.serverTime, client: 0 });
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState<"verify" | "resend" | "back" | null>(null);
  const [error, setError] = useState<{ message: string; invalidCode: boolean } | null>(null);
  const [requestExpired, setRequestExpired] = useState(false);
  const [retryUntil, setRetryUntil] = useState(0);
  useEffect(() => {
    clock.current.client = Date.now();
    const timer = setInterval(() => setNow(clock.current.server + Date.now() - clock.current.client), 1000);
    return () => clearInterval(timer);
  }, []);
  const retrySeconds = Math.max(0, Math.ceil((retryUntil - now) / 1000));
  const resendSeconds = Math.max(retrySeconds, Math.ceil((verification.resendAt - now) / 1000), 0);
  const expired = verification.codeExpiresAt <= now;
  const exhausted = verification.attemptsRemaining === 0;
  const canVerify = !busy && !requestExpired && !retrySeconds && !exhausted && !expired && code.length === 6 && verification.deliveryStatus === "sent";

  function report(cause: unknown, title: string) {
    const message = authErrorMessage(cause);
    const kind = cause instanceof AuthRequestError ? cause.code : "request_failed";
    setError({ message, invalidCode: ["incorrect_code", "invalid_code", "code_expired", "attempts_exhausted"].includes(kind) });
    if (kind === "verification_expired") setRequestExpired(true);
    if (kind === "code_expired") setVerification(current => ({ ...current, codeExpiresAt: 0 }));
    if (kind === "attempts_exhausted") setVerification(current => ({ ...current, attemptsRemaining: 0 }));
    if (kind === "delivery_failed") setVerification(current => ({ ...current, deliveryStatus: "failed" }));
    if (cause instanceof AuthRequestError && cause.retryAfter) {
      const until = now + cause.retryAfter * 1000;
      if (kind === "resend_limited") setVerification(current => ({ ...current, resendAt: until }));
      else setRetryUntil(until);
    }
    notify({ tone: "error", title, description: message });
  }

  async function verify(event: React.FormEvent) {
    event.preventDefault();
    if (!canVerify) return;
    setBusy("verify"); setError(null);
    try {
      const result = await authRequest("/api/auth/email/verify", "POST", { code }, isPasswordAuthResponse);
      if (result.status !== "authenticated") throw new AuthRequestError("Please refresh the page and try again.");
      notify({ title: "Email verified", description: "You’re signed in. Welcome to your workspace." });
      onVerified();
    } catch (cause) { report(cause, "Couldn’t verify your email"); setBusy(null); }
  }
  async function resend() {
    if (busy || requestExpired || resendSeconds > 0) return;
    setBusy("resend"); setError(null);
    try {
      const result = await authRequest("/api/auth/email/resend", "POST", undefined,
        (value): value is { verification: EmailVerificationState } => !!value && typeof value === "object" && "verification" in value && isVerificationState(value.verification));
      const next = result.verification;
      clock.current = { server: next.serverTime, client: Date.now() };
      setVerification(next); setNow(next.serverTime); setCode("");
      if (next.deliveryStatus === "sent") notify({ title: "New code sent", description: "Use the latest code in your inbox. Your previous code will no longer work." });
      else if (next.deliveryStatus === "failed") notify({ tone: "error", title: "We couldn’t send your code", description: deliveryError });
    } catch (cause) { report(cause, "Couldn’t resend your code"); }
    finally { setBusy(null); }
  }
  async function back() {
    if (busy) return;
    setBusy("back"); setError(null);
    try { await authRequest("/api/auth/email/pending", "DELETE"); onBack(verification.email); }
    catch (cause) { report(cause, "Couldn’t return to sign-in"); setBusy(null); }
  }
  const guidance = requestExpired ? "This verification request has expired. Go back to sign in to start again."
    : exhausted ? "Too many incorrect codes. Request a new code below."
    : expired && verification.deliveryStatus === "sent" ? "This code has expired. Request a new code below."
    : verification.deliveryStatus === "failed" ? deliveryError : null;
  return <>
    <h1 className="font-display mt-6 text-[28px] font-semibold tracking-tight">Verify your email</h1>
    <p className="mt-2 text-sm leading-6 text-vs-muted">Confirm your email to finish signing in. You only need to do this once.</p>
    <p className="mt-3 break-all text-sm font-medium text-vs-fg">{verification.email}</p>
    {guidance ? <div id="email-code-guidance" className="mt-4"><ErrorNote announce={false}>{guidance}</ErrorNote></div>
      : verification.deliveryStatus === "sent" ? <div className="mt-4 flex items-start gap-2.5 rounded-xl border border-vs-border bg-vs-editor/60 p-3.5 text-sm leading-6"><CheckIcon className="mt-1 h-4 w-4 shrink-0 text-vs-success" /><p><span className="font-medium">Code sent</span><span className="block text-vs-muted">It may take a moment to arrive. Check your spam folder too.</span></p></div>
      : <p role="status" className="mt-4 text-sm leading-6 text-vs-muted">We’re confirming that your code was sent. Refresh this page to check, or request a new code below.</p>}
    <form onSubmit={verify} aria-busy={busy === "verify"} className="mt-6 space-y-5">
      <Field label="Verification code" hint="Enter the six-digit code from your latest email. Codes expire after 10 minutes.">
        <input autoFocus required type="text" inputMode="numeric" autoComplete="one-time-code" pattern="[0-9]{6}" maxLength={6}
          disabled={!!busy || requestExpired || exhausted || expired || verification.deliveryStatus !== "sent"}
          value={code} onChange={event => { setCode(event.target.value.replace(/\D/g, "").slice(0, 6)); setError(null); }}
          placeholder="000000" aria-invalid={error?.invalidCode || undefined} aria-describedby={error && error.message !== guidance ? "email-code-error" : guidance ? "email-code-guidance" : undefined}
          className={`${inputClass} text-center font-mono text-2xl tracking-[0.35em] disabled:opacity-50`} />
      </Field>
      {error && error.message !== guidance && <div id="email-code-error"><ErrorNote announce={false}>{error.message}</ErrorNote></div>}
      <button type="submit" disabled={!canVerify}
        className="flex min-h-11 w-full items-center justify-center gap-2 rounded-lg bg-vs-accent px-4 py-2.5 text-base font-medium text-vs-accent-fg transition hover:opacity-90 disabled:opacity-60">
        {busy === "verify" && <SpinnerIcon className="h-4 w-4" />}{busy === "verify" ? "Verifying…" : retrySeconds > 0 ? `Try again in ${countdown(retrySeconds)}` : "Verify & sign in"}
      </button>
    </form>
    <div className="mt-5 space-y-3 text-center text-sm">
      <button type="button" onClick={resend} disabled={!!busy || requestExpired || resendSeconds > 0} className="inline-flex min-h-10 items-center justify-center gap-2 rounded-lg px-3 text-vs-fg transition hover:bg-vs-hover disabled:text-vs-muted">
        {busy === "resend" && <SpinnerIcon className="h-4 w-4" />}{busy === "resend" ? "Sending…" : resendSeconds > 0 ? `Resend code in ${countdown(resendSeconds)}` : "Resend code"}
      </button>
      <button type="button" onClick={back} disabled={!!busy} className="block min-h-10 w-full rounded-lg text-vs-muted transition hover:text-vs-fg disabled:opacity-60">{busy === "back" ? "Returning to sign-in…" : "Back to sign in"}</button>
    </div>
  </>;
}
