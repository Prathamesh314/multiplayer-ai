"use client";
import { UserProfile, useAuth } from "@clerk/nextjs";
import Link from "next/link";
export function AccountProfile() {
  const { isLoaded, isSignedIn } = useAuth();
  return <main className="app-page h-dvh overflow-auto p-6"><div className="mx-auto max-w-4xl space-y-6">
    <Link href="/workspace" className="text-sm text-vs-muted">← Back to workspace</Link>
    <h1 className="text-2xl font-bold">Your account</h1>
    {!isLoaded ? <p role="status">Loading your account…</p> : isSignedIn ? <UserProfile routing="hash" /> : <Link href="/login?next=/account">Sign in to manage your account</Link>}
  </div></main>;
}
