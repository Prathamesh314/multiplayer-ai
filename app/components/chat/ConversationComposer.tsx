"use client";

import { useRef, useState } from "react";
import { SendIcon, SpinnerIcon } from "../icons";
import styles from "./chat.module.css";

/** Channel composer: keep the draft until the server accepts the message. */
export function ConversationComposer({
  name,
  disabled,
  onSend,
}: {
  name: string;
  disabled: boolean;
  onSend: (body: string) => Promise<void>;
}) {
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const pending = useRef(false);
  const textarea = useRef<HTMLTextAreaElement>(null);

  async function send() {
    const body = draft.trim();
    if (!body || disabled || pending.current) return;
    pending.current = true;
    setSending(true);
    try {
      await onSend(body);
      setDraft("");
      if (textarea.current) textarea.current.style.height = "auto";
    } catch {
      // The conversation displays the error; preserve the text for a retry.
    } finally {
      pending.current = false;
      setSending(false);
      textarea.current?.focus();
    }
  }

  return (
    <div className={styles.composer}>
      <div className={styles.composerBox}>
        <textarea
          ref={textarea}
          aria-label={`Message ${name}`}
          placeholder={`Message ${name}`}
          value={draft}
          rows={1}
          maxLength={4000}
          disabled={disabled}
          readOnly={sending}
          onChange={(event) => {
            setDraft(event.target.value);
            event.target.style.height = "auto";
            event.target.style.height = `${Math.min(event.target.scrollHeight, 160)}px`;
          }}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
              event.preventDefault();
              void send();
            }
          }}
        />
        <button type="button" aria-label="Send message" onClick={() => void send()} disabled={disabled || sending || !draft.trim()}>
          {sending ? <SpinnerIcon /> : <SendIcon />}
        </button>
      </div>
      <div className={styles.composerHint}>
        <span><kbd>Enter</kbd> to send <span>·</span> <kbd>Shift + Enter</kbd> for a new line</span>
        {draft.length > 3500 && <span>{draft.length.toLocaleString()} / 4,000</span>}
      </div>
    </div>
  );
}
