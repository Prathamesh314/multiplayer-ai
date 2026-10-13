"use client";

import { useEffect, useState } from "react";

/**
 * Cross-fades a chat's name when the chat names itself.
 *
 * A chat is named from its opening prompt, so the name lands a beat after the
 * chat does — "New chat" becomes the real name, and where a naming gateway is
 * configured a drafted name becomes a better one shortly after. Swapping the
 * text in place reads as a glitch; fading the old out and the new in reads as
 * the chat settling on its name.
 *
 * `identity` is the run the name belongs to. Moving between two existing chats
 * is not a rename — holding the previous chat's name on screen for even a
 * fraction of a second, over the new chat's transcript, is simply wrong — so
 * that case snaps. Opening the first chat of a composing panel (null → a run)
 * is the transition worth showing, and still animates.
 *
 * Returns the text to render and the class that animates it, so the caller
 * keeps its own element and typography. `prefers-reduced-motion` readers see
 * the final text immediately — the global rule collapses both durations.
 */
export function useTitleTransition(
  title: string,
  identity: string | null = null,
): { shown: string; className: string } {
  const [shown, setShown] = useState(title);
  const [phase, setPhase] = useState<"idle" | "out" | "in">("idle");
  const [previous, setPrevious] = useState({ title, identity });

  // Adjusted during render rather than in an effect: the fade has to start on
  // the same paint the new title arrives, or the old text lingers a frame.
  if (title !== previous.title || identity !== previous.identity) {
    const switched = previous.identity !== null && identity !== null && previous.identity !== identity;
    setPrevious({ title, identity });
    if (switched) {
      setShown(title);
      setPhase("idle");
    } else if (title !== shown) {
      setPhase("out");
    }
  }

  useEffect(() => {
    if (phase !== "out") return;
    const swap = setTimeout(() => {
      setShown(title);
      setPhase("in");
    }, 130);
    return () => clearTimeout(swap);
  }, [phase, title]);

  useEffect(() => {
    if (phase !== "in") return;
    const settle = setTimeout(() => setPhase("idle"), 320);
    return () => clearTimeout(settle);
  }, [phase]);

  return {
    shown,
    className: `chat-title ${phase === "out" ? "chat-title-out" : phase === "in" ? "chat-title-in" : ""}`,
  };
}
