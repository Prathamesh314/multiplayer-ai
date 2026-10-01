"use client";

import { useParams, useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { fetchMe } from "../../lib/auth/client";
import { acceptInvitationToken } from "../../lib/org/client";
import { SparkleIcon, SpinnerIcon } from "../../components/icons";
import Link from "next/link";

/**
 * Landing for an emailed invite link. If the visitor is signed out we send them
 * to log in and come back; once signed in, redeeming the token drops them into
 * the org.
 */
export default function InvitePage() {
  const router = useRouter();
  const params = useParams<{ token: string }>();
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const token = params.token;
    let cancelled = false;
    void (async () => {
      const me = (await fetchMe()).user;
      if (cancelled) return;
      if (!me) {
        router.replace(`/login?next=${encodeURIComponent(`/invite/${token}`)}`);
        return;
      }
      try {
        await acceptInvitationToken(token);
        if (!cancelled) router.replace("/workspace");
      } catch (cause) {
        if (!cancelled) setError(cause instanceof Error ? cause.message : "That link is not valid.");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [params.token, router]);

  return (
    <main className="app-page grid min-h-dvh place-items-center p-6 text-vs-fg">
      <div className="w-full max-w-md rounded-2xl border border-vs-border bg-vs-panel p-8 text-center shadow-xl">
        <span className="mx-auto flex h-12 w-12 items-center justify-center rounded-2xl bg-vs-accent/10"><SparkleIcon className="h-6 w-6 text-vs-accent" /></span>
        <h1 className="font-display mt-5 text-2xl font-semibold">{error ? "Unable to join" : "Your team is waiting"}</h1>
        {error ? (
          <><p role="alert" className="mt-3 text-sm leading-6 text-vs-danger">{error}</p><Link href="/workspace" className="mt-6 inline-flex rounded-lg bg-vs-accent px-4 py-2.5 text-sm font-semibold text-vs-accent-fg">Back to workspace</Link></>
        ) : (
          <p role="status" className="mt-3 flex items-center justify-center gap-2 text-sm text-vs-muted">
            <SpinnerIcon className="h-4 w-4" /> Joining the organisation…
          </p>
        )}
      </div>
    </main>
  );
}
