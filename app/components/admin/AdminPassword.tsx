"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { SpinnerIcon } from "../icons";
import { AdminShell, fieldClass } from "./AdminLogin";

const MIN = 12;

export function AdminPassword({ email, required }: { email: string; required: boolean }) {
  const router = useRouter();
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const mismatch = confirm.length > 0 && confirm !== next;

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (next !== confirm) return setError("The new passwords don't match.");
    setBusy(true);
    setError(null);
    try {
      const response = await fetch("/api/admin/password", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ current, next }) });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body.error ?? "Could not change the password.");
      router.replace("/admin");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not change the password.");
      setBusy(false);
    }
  }

  return (
    <AdminShell title={required ? "Choose your own password" : "Change password"} subtitle={required ? `${email} is using a generated password. Replace it to continue.` : email}>
      <form method="post" onSubmit={submit} className="space-y-3.5">
        <input type="email" autoComplete="username" value={email} readOnly hidden />
        <label className="block space-y-1.5">
          <span className="text-xs font-medium text-vs-muted">{required ? "Generated password" : "Current password"}</span>
          <input type="password" autoComplete="current-password" required value={current} onChange={(event) => setCurrent(event.target.value)} className={fieldClass} />
        </label>
        <label className="block space-y-1.5">
          <span className="text-xs font-medium text-vs-muted">New password</span>
          <input type="password" autoComplete="new-password" required minLength={MIN} value={next} onChange={(event) => setNext(event.target.value)} className={fieldClass} />
          <span className={`block text-[11px] ${next.length >= MIN ? "text-vs-success" : "text-vs-muted"}`}>At least {MIN} characters{next.length ? ` · ${next.length} so far` : ""}</span>
        </label>
        <label className="block space-y-1.5">
          <span className="text-xs font-medium text-vs-muted">Confirm new password</span>
          <input type="password" autoComplete="new-password" required value={confirm} onChange={(event) => setConfirm(event.target.value)} className={`${fieldClass} ${mismatch ? "border-vs-danger" : ""}`} />
        </label>
        {error && <p role="alert" className="rounded-lg border border-vs-danger/40 bg-vs-danger/10 px-3 py-2 text-xs text-vs-danger">{error}</p>}
        <button type="submit" disabled={busy || next.length < MIN || mismatch} className="flex w-full items-center justify-center gap-2 rounded-lg bg-vs-accent px-3 py-2 text-sm font-medium text-vs-accent-fg transition hover:opacity-90 disabled:opacity-60">
          {busy && <SpinnerIcon className="h-4 w-4" />} Save password
        </button>
        {!required && <a href="/admin" className="block text-center text-xs text-vs-muted hover:text-vs-fg">Back to dashboard</a>}
      </form>
    </AdminShell>
  );
}
