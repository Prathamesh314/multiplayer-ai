"use client";
import Link from "next/link";
import { useAuth, useClerk } from "@clerk/nextjs";
import { useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import { safeReturnPath } from "../../lib/auth/return-path";
import { invitationDetails } from "../../lib/auth/invitation-link";
import { authRequest, authErrorMessage } from "../../lib/auth/request";
import { AuthShell } from "./AuthForm";

export function CompleteSignIn() {
  const { isLoaded, isSignedIn } = useAuth(), { signOut } = useClerk();
  const params = useSearchParams();
  const next = safeReturnPath(params.get("next")), desktopId = params.get("desktop");
  const invitation = params.get("invite") ?? /^\/invite\/([a-zA-Z0-9_-]{43})$/.exec(next)?.[1] ?? "";
  const [token, setToken] = useState(invitation), [retry, setRetry] = useState(0);
  const [error, setError] = useState<string | null>(null), [ready, setReady] = useState(false), [approved, setApproved] = useState(false);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (!isLoaded) return;
    if (!isSignedIn) { location.replace(`/login?${params}`); return; }
    let cancelled = false;
    authRequest("/api/auth/complete", "POST", { invitationToken: invitationDetails(token)?.token || token || undefined })
      .then(() => { if (cancelled) return; if (desktopId) setReady(true); else location.replace(next); })
      .catch(cause => { if (!cancelled) setError(authErrorMessage(cause, "Could not open your workspace. Please try again.")); });
    return () => { cancelled = true; };
    // Read the edited invitation only on explicit retry, not on every keystroke.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isLoaded, isSignedIn, retry, desktopId, next]);
  async function approve() {
    setBusy(true); setError(null);
    try { await authRequest("/api/auth/desktop/approve", "POST", { id: desktopId }); setApproved(true); }
    catch (cause) { setError(authErrorMessage(cause, "Could not approve desktop sign-in.")); }
    finally { setBusy(false); }
  }
  return <AuthShell><section className="space-y-4 rounded-xl border border-vs-border bg-vs-panel p-6">
    <h1 className="text-xl font-bold">{approved ? "Desktop sign-in approved" : ready ? "Confirm desktop sign-in" : "Opening your workspace"}</h1>
    {approved ? <p className="leading-6 text-vs-muted">Return to the desktop app and select Complete sign-in. You can close this browser tab.</p>
      : ready ? <><p className="leading-6 text-vs-muted">Confirm only if the desktop app on your computer shows this code:</p>
        <p className="text-center font-mono text-2xl tracking-widest">{desktopId?.slice(0, 8).toUpperCase()}</p>
        <button disabled={busy} onClick={approve} className="w-full rounded-xl bg-vs-accent p-3 text-vs-accent-fg disabled:opacity-50">{busy ? "Approving…" : "Approve my desktop app"}</button></>
      : !error && <p role="status" className="text-vs-muted">Finishing sign-in…</p>}
    {error && <><p role="alert" className="text-sm leading-6 text-red-300">{error}</p>
      {!ready && <label className="block space-y-2 text-sm text-vs-muted"><span>Invitation link or code (if required)</span><input value={token} onChange={e => setToken(e.target.value)} placeholder="Paste your invitation link or code" className="w-full rounded-lg border border-vs-border bg-vs-editor p-3 text-vs-fg" /></label>}
      {!ready && <button onClick={() => { setError(null); setRetry(n => n + 1); }} className="rounded-lg bg-vs-accent px-4 py-2 text-vs-accent-fg">Try again</button>}</>}
    {error && <Link href="/account" className="block text-sm text-vs-muted underline underline-offset-4">Manage your email and account settings</Link>}
    <button onClick={() => void signOut({ redirectUrl: "/login" })} className="text-sm text-vs-muted underline underline-offset-4">Use a different account</button>
  </section></AuthShell>;
}
