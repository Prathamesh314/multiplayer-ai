"use client";

import { useState, useSyncExternalStore } from "react";
import { useRouter } from "next/navigation";
import type { pendingGoogleProfile } from "../../lib/auth/google-store";
import { desktopBridge } from "../../lib/desktop";
import { invitationDetails } from "../../lib/auth/invitation-link";
import { Field, ErrorNote, inputClass } from "../ui/Modal";
import { SpinnerIcon } from "../icons";

export type PendingGoogleProfile = NonNullable<Awaited<ReturnType<typeof pendingGoogleProfile>>>;
const subscribe = () => () => {};
const client = () => true, server = () => false;
async function post(path: string, body: unknown) {
  const response = await fetch(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const result = await response.json().catch(() => null);
  if (!response.ok) throw new Error(result?.error ?? "Could not complete Google sign-in. Please try again.");
  return result;
}
const base64url = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes)).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");

export function GoogleSignIn({ next, invitationToken, desktopId }: { next: string; invitationToken?: string; desktopId?: string | null }) {
  const ready = useSyncExternalStore(subscribe, client, server);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [desktop, setDesktop] = useState<{ id: string; code: string; verifier: string; url: string } | null>(null);
  const router = useRouter();
  async function start() {
    setBusy(true); setError(null);
    try {
      const params = new URLSearchParams({ next });
      if (invitationToken) params.set("invite", invitationToken);
      if (desktopId) params.set("desktop", desktopId);
      if (desktopBridge()?.isDesktop) {
        const verifier = base64url(crypto.getRandomValues(new Uint8Array(32)));
        const challenge = base64url(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))));
        const request = await post("/api/auth/google/desktop", { challenge });
        params.set("desktop", request.id);
        const url = new URL(`/login?${params}`, location.origin).href;
        setDesktop({ ...request, verifier, url });
        window.open(url, "_blank", "noopener,noreferrer");
        setBusy(false);
      } else {
        location.assign(new URL(`/api/auth/google/start?${params}`, location.origin).href);
      }
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Could not open Google sign-in."); setBusy(false); }
  }
  async function finishDesktop() {
    if (!desktop) return;
    setBusy(true); setError(null);
    try {
      await post("/api/auth/google/desktop/complete", { id: desktop.id, verifier: desktop.verifier });
      setDesktop(null); router.push(next); router.refresh();
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Could not complete sign-in."); setBusy(false); }
  }
  return <div className="mt-6 space-y-3">
    {desktop ? <div className="space-y-3 rounded-xl border border-vs-border bg-vs-editor p-4 text-sm">
      <p className="font-medium">Continue in your browser</p>
      <p className="leading-6 text-vs-muted">Sign in with Google and confirm the matching code <strong className="font-mono text-vs-fg">{desktop.code}</strong>. Then return here.</p>
      <button type="button" disabled={busy} onClick={finishDesktop} className="w-full rounded-lg bg-vs-accent px-4 py-2.5 font-medium text-vs-accent-fg disabled:opacity-60">{busy ? "Completing sign-in…" : "Complete sign-in"}</button>
      <a href={desktop.url} target="_blank" rel="noopener noreferrer" className="block text-center text-vs-muted underline underline-offset-4">Reopen browser</a>
      <button type="button" disabled={busy} onClick={() => { setDesktop(null); setError(null); }} className="w-full text-vs-muted hover:text-vs-fg">Cancel</button>
    </div> : <>
      {desktopId && <p className="rounded-xl border border-vs-border p-3 text-sm leading-6 text-vs-muted">You are signing in to the desktop app. Continue only if you started this request and the app shows code <strong className="font-mono text-vs-fg">{desktopId.slice(0, 8).toUpperCase()}</strong>.</p>}
      <button type="button" onClick={start} disabled={!ready || busy} className="flex min-h-11 w-full items-center justify-center gap-3 rounded-lg border border-[#747775] bg-white px-4 py-2.5 text-[15px] font-medium text-[#1f1f1f] transition hover:bg-[#f2f2f2] disabled:opacity-60">
        {busy ? <SpinnerIcon className="h-5 w-5" /> : <GoogleIcon />}
        {busy ? "Opening Google…" : "Continue with Google"}
      </button>
    </>}
    {error && <ErrorNote>{error}</ErrorNote>}
    <div className="flex items-center gap-3 pt-2 text-xs text-vs-muted"><span className="h-px flex-1 bg-vs-border" />or use email<span className="h-px flex-1 bg-vs-border" /></div>
  </div>;
}

export function GoogleCompletion({ profile, signupMode }: { profile: PendingGoogleProfile; signupMode: "open" | "invite" | "closed" }) {
  const [handle, setHandle] = useState("");
  const [password, setPassword] = useState("");
  const [invitation, setInvitation] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const ready = useSyncExternalStore(subscribe, client, server);
  const blocked = profile.unavailable || (profile.mode === "signup" && signupMode === "closed");
  async function submit(event: React.FormEvent) {
    event.preventDefault(); setBusy(true); setError(null);
    try {
      const result = await post("/api/auth/google/complete", {
        handle, password, invitationToken: invitationDetails(invitation)?.token ?? (invitation.trim() || undefined),
      });
      // Full navigation removes the consumed server-rendered OAuth profile.
      location.assign(result.next);
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Could not finish sign-in."); setBusy(false); }
  }
  return <>
    <h1 className="font-display mt-6 text-[28px] font-semibold tracking-tight">{profile.mode === "signup" ? "Pick a username" : profile.mode === "link" ? "Link your Google account" : profile.desktop ? "Sign in to the desktop app" : "Continue with Google"}</h1>
    <p className="mt-2 break-words text-sm leading-6 text-vs-muted">Google verified <strong className="font-medium text-vs-fg">{profile.email}</strong>.</p>
    {profile.mode === "link" && <p className="mt-3 text-sm leading-6 text-vs-muted">An account already uses this email. Enter its password once to connect Google and keep your projects.</p>}
    {profile.desktop && <p className="mt-4 rounded-xl border border-vs-border p-3 text-sm leading-6 text-vs-muted">This will sign in to the desktop app showing <strong className="font-mono text-vs-fg">{profile.desktopCode}</strong>. Confirm only if you started that request.</p>}
    {blocked ? <div className="mt-5"><ErrorNote>{profile.unavailable ? "This account is unavailable. Contact your administrator." : "New registrations are currently closed. Existing accounts can still sign in."}</ErrorNote></div> :
      <form onSubmit={submit} className="mt-6 space-y-5">
        {profile.mode === "signup" && <Field label="Username" hint="2–39 lowercase letters, numbers, dashes or underscores."><input autoFocus required autoComplete="username" className={inputClass} value={handle} onChange={event => setHandle(event.target.value.toLowerCase())} /></Field>}
        {profile.mode === "link" && <Field label="Existing account password"><input autoFocus required type="password" autoComplete="current-password" className={inputClass} value={password} onChange={event => setPassword(event.target.value)} /></Field>}
        {profile.mode === "signup" && signupMode === "invite" && <Field label="Invitation link or code" hint="An invitation opened before Google sign-in is already attached. You can paste a newer one here."><input autoComplete="off" autoCapitalize="none" spellCheck={false} className={inputClass} placeholder="Paste your invitation link or code" value={invitation} onChange={event => setInvitation(event.target.value)} /></Field>}
        {error && <ErrorNote>{error}</ErrorNote>}
        <button type="submit" disabled={!ready || busy} className="flex min-h-11 w-full items-center justify-center gap-2 rounded-lg bg-vs-accent px-4 py-2.5 font-medium text-vs-accent-fg disabled:opacity-60">
          {busy && <SpinnerIcon className="h-4 w-4" />}{profile.mode === "signup" ? "Create account & sign in" : profile.mode === "link" ? "Link Google & sign in" : profile.desktop ? "Confirm desktop sign-in" : "Sign in"}
        </button>
      </form>}
    <a href={`/api/auth/google/start?${new URLSearchParams({ next: profile.next, ...(profile.desktopId ? { desktop: profile.desktopId } : {}) })}`} className="mt-5 block text-center text-sm text-vs-muted underline underline-offset-4">Use a different Google account</a>
    <a href={`/login?${new URLSearchParams({ google: "restart", next: profile.next })}`} className="mt-3 block text-center text-sm text-vs-muted underline underline-offset-4">Back to email sign-in</a>
  </>;
}

function GoogleIcon() {
  return <svg aria-hidden="true" width="20" height="20" viewBox="0 0 48 48"><path fill="#EA4335" d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5Z" /><path fill="#4285F4" d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6C44.4 38.02 46.98 31.87 46.98 24.55Z" /><path fill="#FBBC05" d="M10.53 28.59A14.41 14.41 0 0 1 9.75 24c0-1.59.27-3.13.78-4.59l-7.98-6.19A23.87 23.87 0 0 0 0 24c0 3.88.93 7.55 2.56 10.78l7.97-6.19Z" /><path fill="#34A853" d="M24 48c6.48 0 11.93-2.13 15.91-5.8l-7.73-6c-2.15 1.45-4.92 2.3-8.18 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48Z" /></svg>;
}
