"use client";
import { useSignIn } from "@clerk/nextjs";
import { useState, useSyncExternalStore } from "react";
import { desktopBridge } from "../../lib/desktop";
import { authRequest, authErrorMessage } from "../../lib/auth/request";
const subscribe = () => () => {};
const base64url = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes)).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
export function DesktopSignIn({ complete, flow }: { complete: string; flow: string }) {
  const isDesktop = useSyncExternalStore(subscribe, () => !!desktopBridge()?.isDesktop, () => false);
  const { signIn } = useSignIn();
  const [pending, setPending] = useState<{ id: string; code: string; verifier: string; url: string } | null>(null);
  const [busy, setBusy] = useState(false), [error, setError] = useState<string | null>(null);
  if (!isDesktop) return null;
  async function start() {
    setBusy(true); setError(null);
    try {
      const verifier = base64url(crypto.getRandomValues(new Uint8Array(32)));
      const challenge = base64url(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))));
      const result = await authRequest<{ id: string; code: string }>("/api/auth/desktop", "POST", { challenge });
      const params = new URLSearchParams(flow); params.set("desktop", result.id);
      const url = new URL(`/login?${params}`, location.origin).href;
      setPending({ ...result, verifier, url }); window.open(url, "_blank", "noopener,noreferrer");
    } catch (cause) { setError(authErrorMessage(cause, "Could not open sign-in. Please try again.")); }
    finally { setBusy(false); }
  }
  async function finish() {
    if (!pending || !signIn) return;
    setBusy(true); setError(null);
    try {
      const { ticket } = await authRequest<{ ticket: string }>("/api/auth/desktop/redeem", "POST", { id: pending.id, verifier: pending.verifier });
      const attempt = await signIn.ticket({ ticket });
      if (attempt.error || signIn.status !== "complete") throw new Error("Could not finish desktop sign-in. Start again and approve it in your browser.");
      const result = await signIn.finalize({ navigate: async ({ decorateUrl }) => { location.assign(decorateUrl(complete)); } });
      if (result.error) throw new Error("Could not activate your session. Please start sign-in again.");
    } catch (cause) { setError(authErrorMessage(cause, "Could not complete desktop sign-in.")); }
    finally { setBusy(false); }
  }
  return <section className="space-y-3 rounded-xl border border-vs-border bg-vs-panel p-4 text-sm">
    {pending ? <><p className="leading-6 text-vs-muted">Sign in in your browser and confirm code <strong className="font-mono text-vs-fg">{pending.code}</strong>. Then return here.</p>
      <button disabled={busy || !signIn} onClick={finish} className="w-full rounded-lg bg-vs-accent p-3 text-vs-accent-fg disabled:opacity-50">{busy ? "Completing sign-in…" : "Complete sign-in"}</button>
      <a href={pending.url} target="_blank" rel="noopener noreferrer" className="inline-block text-vs-muted underline">Reopen browser</a>
      <button disabled={busy} onClick={() => { setPending(null); setError(null); }} className="ml-4 text-vs-muted underline">Start again</button></>
      : <><p className="text-vs-muted">Use your browser for Google sign-in and your saved accounts.</p><button disabled={busy} onClick={start} className="w-full rounded-lg bg-vs-accent p-3 text-vs-accent-fg disabled:opacity-50">{busy ? "Opening browser…" : "Sign in with your browser"}</button></>}
    {error && <p role="alert" className="text-red-300">{error}</p>}
  </section>;
}
