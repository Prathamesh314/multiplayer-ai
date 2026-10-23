"use client";
import { useClerk } from "@clerk/nextjs";
import { useRef, useState, useSyncExternalStore } from "react";
import { desktopBridge } from "../../lib/desktop";
import { authRequest, authErrorMessage } from "../../lib/auth/request";
import { finishDesktopSignIn, type DesktopSignInAttempt } from "../../lib/auth/desktop-sign-in";
const subscribe = () => () => {};
const base64url = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes)).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
export function DesktopSignIn({ complete, flow }: { complete: string; flow: string }) {
  const isDesktop = useSyncExternalStore(subscribe, () => !!desktopBridge()?.isDesktop, () => false);
  const clerk = useClerk();
  const [pending, setPending] = useState<(DesktopSignInAttempt & { code: string; url: string }) | null>(null);
  const inFlight = useRef(false);
  const [busy, setBusy] = useState(false), [error, setError] = useState<string | null>(null);
  if (!isDesktop) return null;
  async function start() {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(true); setError(null);
    try {
      const verifier = base64url(crypto.getRandomValues(new Uint8Array(32)));
      const challenge = base64url(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))));
      const result = await authRequest<{ id: string; code: string }>("/api/auth/desktop", "POST", { challenge });
      const params = new URLSearchParams(flow); params.set("desktop", result.id);
      const url = new URL(`/login?${params}`, location.origin).href;
      setPending({ ...result, verifier, url }); window.open(url, "_blank", "noopener,noreferrer");
    } catch (cause) { setError(authErrorMessage(cause, "Could not open sign-in. Please try again.")); }
    finally { inFlight.current = false; setBusy(false); }
  }
  async function finish() {
    if (!pending || !clerk.loaded || inFlight.current) return;
    inFlight.current = true;
    setBusy(true); setError(null);
    try {
      await finishDesktopSignIn(pending, clerk, async ({ session, decorateUrl }) => {
        // Pending sessions must finish Clerk's required tasks before the app's
        // account-completion endpoint can treat them as signed in.
        const destination = session.currentTask ? `/login?${flow}#/tasks` : complete;
        location.assign(decorateUrl(destination));
      });
    } catch (cause) { setError(authErrorMessage(cause, "Could not complete desktop sign-in.")); }
    finally { inFlight.current = false; setBusy(false); }
  }
  if (!pending) return <div className="space-y-4">
    <button disabled={busy} onClick={start}
      className="flex w-full items-center justify-center gap-3 rounded-xl border border-vs-border bg-vs-panel p-3 text-sm font-medium hover:bg-vs-hover disabled:opacity-50">
      <GoogleMark />{busy ? "Opening your browser…" : "Continue with Google"}
    </button>
    <p className="-mt-2 text-center text-xs text-vs-muted">Opens your browser, where you’re already signed in.</p>
    {error && <p role="alert" className="text-sm text-red-300">{error}</p>}
    <div className="flex items-center gap-3 text-xs text-vs-muted" aria-hidden="true"><span className="h-px flex-1 bg-vs-border" />or<span className="h-px flex-1 bg-vs-border" /></div>
  </div>;
  return <section className="space-y-3 rounded-xl border border-vs-border bg-vs-panel p-4 text-sm">
    <p className="leading-6 text-vs-muted">Sign in in your browser and confirm code <strong className="font-mono text-vs-fg">{pending.code}</strong>. Then return here.</p>
    <button disabled={busy || !clerk.loaded} onClick={finish} className="w-full rounded-lg bg-vs-accent p-3 text-vs-accent-fg disabled:opacity-50">{busy ? "Completing sign-in…" : "Complete sign-in"}</button>
    <a href={pending.url} target="_blank" rel="noopener noreferrer" className="inline-block text-vs-muted underline">Reopen browser</a>
    <button disabled={busy} onClick={() => { setPending(null); setError(null); }} className="ml-4 text-vs-muted underline">Start again</button>
    {error && <p role="alert" className="text-red-300">{error}</p>}
  </section>;
}

function GoogleMark() {
  return <svg aria-hidden="true" viewBox="0 0 48 48" className="h-4 w-4">
    <path fill="#FFC107" d="M43.6 20.5H42V20H24v8h11.3C33.7 32.7 29.2 36 24 36c-6.6 0-12-5.4-12-12s5.4-12 12-12c3.1 0 5.8 1.2 7.9 3.1l5.7-5.7C34 6.1 29.3 4 24 4 12.9 4 4 12.9 4 24s8.9 20 20 20 20-8.9 20-20c0-1.3-.1-2.4-.4-3.5z" />
    <path fill="#FF3D00" d="m6.3 14.7 6.6 4.8C14.7 15.1 19 12 24 12c3.1 0 5.8 1.2 7.9 3.1l5.7-5.7C34 6.1 29.3 4 24 4 16.3 4 9.7 8.3 6.3 14.7z" />
    <path fill="#4CAF50" d="M24 44c5.2 0 9.9-2 13.4-5.2l-6.2-5.2C29.2 35.1 26.7 36 24 36c-5.2 0-9.6-3.3-11.3-7.9l-6.5 5C9.5 39.6 16.2 44 24 44z" />
    <path fill="#1976D2" d="M43.6 20.5H42V20H24v8h11.3c-.8 2.2-2.2 4.2-4.1 5.6l6.2 5.2C37 39.2 44 34 44 24c0-1.3-.1-2.4-.4-3.5z" />
  </svg>;
}
