"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { ShieldIcon, SpinnerIcon } from "../icons";

export function AdminShell({ title, subtitle, children }: { title: string; subtitle: string; children: React.ReactNode }) {
  return (
    <main className="relative flex min-h-dvh items-center justify-center overflow-hidden px-4 py-10">
      <div aria-hidden className="pointer-events-none absolute inset-0 bg-[radial-gradient(60rem_30rem_at_50%_-10%,color-mix(in_oklab,var(--vs-accent)_18%,transparent),transparent)]" />
      <div className="relative w-full max-w-sm">
        <div className="mb-6 flex flex-col items-center text-center">
          <span className="mb-4 flex h-11 w-11 items-center justify-center rounded-2xl border border-vs-border bg-vs-panel shadow-sm"><ShieldIcon className="h-5 w-5 text-vs-accent" /></span>
          <h1 className="text-lg font-semibold tracking-tight">{title}</h1>
          <p className="mt-1 text-sm text-vs-muted">{subtitle}</p>
        </div>
        <div className="rounded-2xl border border-vs-border bg-vs-panel p-5 shadow-xl shadow-black/10">{children}</div>
        <p className="mt-4 text-center text-xs text-vs-muted">Platform administrators only. Every sign-in is recorded.</p>
      </div>
    </main>
  );
}

export const fieldClass = "w-full rounded-lg border border-vs-border bg-vs-editor px-3 py-2 text-sm outline-none transition placeholder:text-vs-muted focus:border-vs-accent focus:ring-2 focus:ring-vs-accent/20";

export function AdminLogin() {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const response = await fetch("/api/admin/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email, password }) });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body.error ?? "Could not sign in.");
      router.replace(body.mustChangePassword ? "/admin/password" : "/admin");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not sign in.");
      setBusy(false);
    }
  }

  return (
    <AdminShell title="Multicode AI Admin" subtitle="Sign in to the operator dashboard">
      <form method="post" onSubmit={submit} className="space-y-3.5">
        <label className="block space-y-1.5">
          <span className="text-xs font-medium text-vs-muted">Email</span>
          <input type="email" autoComplete="username" required value={email} onChange={(event) => setEmail(event.target.value)} className={fieldClass} placeholder="name@company.com" />
        </label>
        <label className="block space-y-1.5">
          <span className="text-xs font-medium text-vs-muted">Password</span>
          <input type="password" autoComplete="current-password" required value={password} onChange={(event) => setPassword(event.target.value)} className={fieldClass} />
        </label>
        {error && <p role="alert" className="rounded-lg border border-vs-danger/40 bg-vs-danger/10 px-3 py-2 text-xs text-vs-danger">{error}</p>}
        <button type="submit" disabled={busy} className="flex w-full items-center justify-center gap-2 rounded-lg bg-vs-accent px-3 py-2 text-sm font-medium text-vs-accent-fg transition hover:opacity-90 disabled:opacity-60">
          {busy && <SpinnerIcon className="h-4 w-4" />} Sign in
        </button>
      </form>
    </AdminShell>
  );
}
