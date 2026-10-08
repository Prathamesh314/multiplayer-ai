"use client";
import { SignIn, SignUp, useAuth } from "@clerk/nextjs";
import Link from "next/link";
import { useEffect, useSyncExternalStore } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { safeReturnPath } from "../../lib/auth/return-path";
import { ExecutionRequirements } from "../ai/ExecutionRequirements";
import { desktopBridge } from "../../lib/desktop";
import { DesktopSignIn } from "./DesktopSignIn";

export function AuthShell({ children }: { children: React.ReactNode }) {
  return <main className="app-page h-dvh overflow-y-auto px-5 py-10 text-vs-fg">
    <div className="mx-auto w-full max-w-md space-y-6">
      <Link href="/" className="block text-lg font-semibold tracking-tight">multiplayer-ai</Link>
      {children}
      <ExecutionRequirements />
      <p className="text-center text-sm text-vs-muted"><Link href="/docs" className="hover:text-vs-fg">Setup guide</Link> · <Link href="/" className="hover:text-vs-fg">Back to home</Link></p>
    </div>
  </main>;
}

export function AuthUnavailable() {
  return <AuthShell><section className="rounded-xl border border-vs-border bg-vs-panel p-6">
    <h1 className="text-xl font-bold">Sign-in is being configured</h1>
    <p role="status" className="mt-3 leading-6 text-vs-muted">Please try again shortly. Your existing workspace and conversations are safe.</p>
  </section></AuthShell>;
}

const subscribe = () => () => {};
export function AuthForm({ signupMode }: { signupMode: "open" | "invite" | "closed" }) {
  const isDesktop = useSyncExternalStore(subscribe, () => !!desktopBridge()?.isDesktop, () => false);
  const params = useSearchParams(), router = useRouter();
  const { isLoaded, isSignedIn } = useAuth();
  const next = safeReturnPath(params.get("next"));
  const invitation = params.get("invite") ?? /^\/invite\/([a-zA-Z0-9_-]{43})$/.exec(next)?.[1] ?? "";
  const flow = new URLSearchParams({ next });
  if (invitation) flow.set("invite", invitation);
  const desktopId = params.get("desktop");
  if (desktopId) flow.set("desktop", desktopId);
  const complete = `/auth/complete?${flow}`;
  const signup = params.get("mode") === "signup" && signupMode !== "closed";
  useEffect(() => { if (isLoaded && isSignedIn) router.replace(complete); }, [isLoaded, isSignedIn, router, complete]);
  return <AuthShell>
    <div><h1 className="text-2xl font-bold">{signup ? "Create your account" : "Welcome back"}</h1>
      <p className="mt-2 text-sm leading-6 text-vs-muted">{signup ? "One account for your conversations and team workspaces." : "Sign in to continue to your workspace."}</p>
      <p className="mt-2 text-sm leading-6 text-vs-muted">Already have a workspace? Use the same email address to keep your chats and access.</p>
    </div>
    {signupMode !== "open" && <p className="text-sm text-vs-muted">{signupMode === "closed" ? "New workspace accounts are currently closed." : "New workspace accounts need an invitation. You can enter it after verifying your email."}</p>}
    {desktopId && <p className="rounded-xl border border-vs-border p-4 text-sm text-vs-muted">Only continue if you started sign-in from the desktop app. You’ll confirm its code after signing in.</p>}
    <DesktopSignIn complete={complete} flow={flow.toString()} />
    {!isDesktop && (!isLoaded || isSignedIn ? <p role="status" className="text-sm text-vs-muted">Opening sign in…</p> : signup
      ? <SignUp routing="hash" signInUrl={`/login?${flow}`} forceRedirectUrl={complete} signInForceRedirectUrl={complete} />
      : <SignIn routing="hash" signUpUrl={`/login?${flow}&mode=signup`} forceRedirectUrl={complete} signUpForceRedirectUrl={complete} />)}
  </AuthShell>;
}
