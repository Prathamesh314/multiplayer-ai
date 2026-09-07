"use client";

import { useParams, useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { fetchMe } from "../../lib/auth/client";
import { acceptInvitationToken } from "../../lib/org/client";
import { SparkleIcon, SpinnerIcon } from "../../components/icons";

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
        if (!cancelled) router.replace("/");
      } catch (cause) {
        if (!cancelled) setError(cause instanceof Error ? cause.message : "That link is not valid.");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [params.token, router]);

  return (
    <div className="grid min-h-dvh place-items-center bg-vs-editor text-vs-fg">
      <div className="max-w-sm text-center">
        <SparkleIcon className="mx-auto h-6 w-6 text-vs-accent" />
        {error ? (
          <p className="mt-4 text-base text-vs-danger">{error}</p>
        ) : (
          <p className="mt-4 flex items-center justify-center gap-2 text-base text-vs-muted">
            <SpinnerIcon className="h-4 w-4" /> Joining the organisation…
          </p>
        )}
      </div>
    </div>
  );
}
