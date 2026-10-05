"use client";

import { useEffect, useState } from "react";
import type { EmailVerificationState } from "../../lib/auth/types";
import { ErrorNote, Field, inputClass } from "../ui/Modal";
import { SpinnerIcon } from "../icons";

async function verificationRequest(path: string, method: string, body?: unknown) {
  const response = await fetch(path, { method, headers: body === undefined ? undefined : { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  const result = await response.json().catch(() => null);
  if (!response.ok) throw Object.assign(new Error(result?.error ?? "Could not verify your email. Please try again."), { retryAfter: Number(response.headers.get("retry-after")) || 0 });
  return result;
}

export function EmailVerification({ initial, onVerified, onBack }: {
  initial: EmailVerificationState; onVerified: () => void; onBack: (email: string) => void;
}) {
  const [verification, setVerification] = useState(initial);
  const [now, setNow] = useState(initial.serverTime);
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState<"verify" | "resend" | "back" | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => { const timer = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(timer); }, []);
  const resendSeconds = Math.max(0, Math.ceil((verification.resendAt - now) / 1000));
  const expired = verification.codeExpiresAt <= now;

  async function verify(event: React.FormEvent) {
    event.preventDefault(); setBusy("verify"); setError(null);
    try {
      await verificationRequest("/api/auth/email/verify", "POST", { code });
      onVerified();
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Could not verify your email."); setBusy(null); }
  }
  async function resend() {
    setBusy("resend"); setError(null);
    try {
      const result = await verificationRequest("/api/auth/email/resend", "POST");
      setVerification(result.verification); setNow(result.verification.serverTime); setCode("");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not send another code.");
      const retryAfter = (cause as { retryAfter?: number })?.retryAfter;
      if (retryAfter) { const time = Date.now(); setNow(time); setVerification(current => ({ ...current, resendAt: time + retryAfter * 1000 })); }
    } finally { setBusy(null); }
  }
  async function back() {
    setBusy("back"); setError(null);
    try { await verificationRequest("/api/auth/email/pending", "DELETE"); onBack(verification.email); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "Please try again."); setBusy(null); }
  }
  return <>
    <h1 className="font-display mt-6 text-[28px] font-semibold tracking-tight">Verify your email</h1>
    <p className="mt-2 text-sm leading-6 text-vs-muted">Enter the six-digit code sent to <span className="break-all text-vs-fg">{verification.email}</span>. You only need to do this once.</p>
    {verification.deliveryStatus === "failed" && <div className="mt-4"><ErrorNote>We couldn’t send your code. Please try sending it again below.</ErrorNote></div>}
    {verification.deliveryStatus === "pending" && <p role="status" className="mt-4 text-sm text-vs-muted">Your code is being sent. Check your inbox shortly.</p>}
    <form onSubmit={verify} className="mt-7 space-y-5">
      <Field label="Verification code" hint={expired ? "This code has expired. Request a new one below." : "Your code expires in 10 minutes. Check your spam folder too."}>
        <input autoFocus required type="text" inputMode="numeric" autoComplete="one-time-code" pattern="[0-9]{6}" maxLength={6}
          value={code} onChange={event => { setCode(event.target.value.replace(/\D/g, "").slice(0, 6)); setError(null); }}
          placeholder="000000" aria-invalid={!!error} aria-describedby={error ? "email-code-error" : undefined}
          className={`${inputClass} text-center font-mono text-2xl tracking-[0.35em]`} />
      </Field>
      {error && <div id="email-code-error"><ErrorNote>{error}</ErrorNote></div>}
      <button type="submit" disabled={!!busy || code.length !== 6 || verification.deliveryStatus !== "sent" || expired}
        className="flex min-h-11 w-full items-center justify-center gap-2 rounded-lg bg-vs-accent px-4 py-2.5 text-base font-medium text-vs-accent-fg transition hover:opacity-90 disabled:opacity-60">
        {busy === "verify" && <SpinnerIcon className="h-4 w-4" />}Verify &amp; sign in
      </button>
    </form>
    <div className="mt-5 space-y-3 text-center text-sm">
      <button type="button" onClick={resend} disabled={!!busy || resendSeconds > 0} className="min-h-10 rounded-lg px-3 text-vs-fg hover:bg-vs-hover disabled:text-vs-muted">
        {busy === "resend" ? "Sending…" : resendSeconds > 0 ? `Resend code in ${resendSeconds}s` : "Resend code"}
      </button>
      <button type="button" onClick={back} disabled={!!busy} className="block min-h-10 w-full rounded-lg text-vs-muted hover:text-vs-fg disabled:opacity-60">Back to sign in</button>
    </div>
  </>;
}
