"use client";
import { useEffect, useState } from "react";
import type { CurrentUser } from "../../lib/auth/types";
import { ErrorNote, inputClass, PrimaryButton } from "../ui/Modal";

/**
 * Your @username: how teammates mention you and assign you tasks. It belongs
 * to this app, so it is changed here; your name, email and password are in the
 * account profile below.
 */
export function UsernameCard() {
  const [user, setUser] = useState<CurrentUser | null>(null);
  const [draft, setDraft] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    const controller = new AbortController();
    void fetch("/api/auth/me", { cache: "no-store", signal: controller.signal })
      .then((response) => response.json())
      .then((data: { user: CurrentUser | null }) => { if (data.user) { setUser(data.user); setDraft(data.user.handle); } })
      .catch(() => {});
    return () => controller.abort();
  }, []);

  if (!user) return null;
  const next = draft.trim().replace(/^@/, "").toLowerCase();
  const changed = next !== user.handle;

  async function save(event: React.FormEvent) {
    event.preventDefault();
    if (!changed || saving) return;
    setSaving(true); setError(null); setSaved(false);
    try {
      const response = await fetch("/api/auth/me", { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ handle: next }) });
      const data = await response.json().catch(() => null) as { user?: CurrentUser; error?: string } | null;
      if (!response.ok || !data?.user) throw new Error(data?.error ?? "Couldn’t change your username. Try again.");
      setUser(data.user); setDraft(data.user.handle); setSaved(true);
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setSaving(false); }
  }

  return (
    <section aria-labelledby="username-heading" className="rounded-2xl border border-vs-border bg-vs-panel p-5">
      <h2 id="username-heading" className="text-base font-semibold">Username</h2>
      <p className="mt-1 text-sm leading-6 text-vs-muted">Teammates mention you and assign you tasks with <span className="text-vs-fg">@{user.handle}</span>. Your name, email and password are in your profile below.</p>
      <form onSubmit={save} className="mt-4 flex flex-wrap items-start gap-2">
        <label className="flex min-w-0 flex-1 basis-60 items-center rounded-lg border border-vs-border bg-vs-editor pl-3 focus-within:border-vs-accent">
          <span aria-hidden className="text-sm text-vs-muted">@</span>
          <input aria-label="Username" value={draft} onChange={(event) => { setDraft(event.target.value); setSaved(false); setError(null); }}
            maxLength={40} autoComplete="username" spellCheck={false} autoCapitalize="none"
            className={`${inputClass} mt-0 min-w-0 flex-1 border-0 bg-transparent pl-1 focus:border-0`} />
        </label>
        <PrimaryButton type="submit" disabled={!changed || saving} className="min-h-9">{saving ? "Saving…" : "Save username"}</PrimaryButton>
      </form>
      <p className="mt-2 text-xs leading-5 text-vs-muted">2–39 lowercase letters, numbers, - or _. Earlier messages keep the old @username as written.</p>
      {saved && <p role="status" className="mt-2 text-sm text-emerald-400">Saved. You’re now @{user.handle}.</p>}
      {error && <div className="mt-3"><ErrorNote>{error}</ErrorNote></div>}
    </section>
  );
}
