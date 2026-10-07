"use client";

import { useState } from "react";
import { joinSession, parseSessionId } from "../../lib/session/client";
import { parseShareLink } from "../../lib/session/share";
import { ShieldIcon, SpinnerIcon } from "../icons";
import { ErrorNote, Field, GhostButton, inputClass, Modal, PrimaryButton } from "../ui/Modal";

export function JoinSessionDialog({
  onClose,
  onJoined,
}: {
  onClose: () => void;
  onJoined: (sessionId: string) => void;
}) {
  const [target, setTarget] = useState("");
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  /**
   * A pasted share link already carries its code, so asking for it again would
   * be a dead end — the answer is sitting in the box above.
   */
  function onTargetChange(value: string) {
    setTarget(value);
    const shared = parseShareLink(value).code;
    if (shared) setCode(shared.toUpperCase());
  }

  async function join() {
    const id = parseSessionId(target);
    if (!id) {
      setError("Paste the session link or its id.");
      return;
    }

    setBusy(true);
    setError(null);
    try {
      const session = await joinSession(id, code);
      onJoined(session.id);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not join that session.");
      setBusy(false);
    }
  }

  return (
    <Modal
      title="Join a session"
      description="Ask whoever created the session for its link and access code."
      onClose={onClose}
      footer={
        <>
          <GhostButton onClick={onClose} disabled={busy}>
            Cancel
          </GhostButton>
          <PrimaryButton onClick={join} disabled={busy}>
            {busy && <SpinnerIcon className="h-4 w-4" />}
            {busy ? "Joining…" : "Join session"}
          </PrimaryButton>
        </>
      }
    >
      <Field label="Session link or id">
        <input
          autoFocus
          value={target}
          onChange={(event) => onTargetChange(event.target.value)}
          placeholder="http://localhost:3000/s/…"
          className={`${inputClass} font-mono`}
        />
      </Field>

      <Field label="Access code">
        <input
          value={code}
          onChange={(event) => setCode(event.target.value.toUpperCase())}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !busy) void join();
          }}
          placeholder="A1B2-C3D4"
          className={`${inputClass} font-mono tracking-[0.14em] placeholder:tracking-normal`}
        />
      </Field>

      <p className="flex items-start gap-2 rounded-lg border border-vs-border bg-vs-editor px-3 py-2.5 text-chrome leading-5 text-vs-muted">
        <ShieldIcon className="mt-0.5 h-3.5 w-3.5 shrink-0 text-vs-accent" />
        Both parts are required. A session link that was forwarded on, or copied out of someone
        else&apos;s browser, will not open without its code.
      </p>

      {error && <ErrorNote>{error}</ErrorNote>}
    </Modal>
  );
}
