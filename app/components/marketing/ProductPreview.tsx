"use client";

import Image from "next/image";
import { useRef, useState } from "react";
import styles from "./marketing.module.css";

const views = [
  {
    label: "Team channels",
    src: "/product/team-chat.png",
    width: 1440,
    height: 900,
    alt: "The updated Multiplayer AI team chat: workspace rail, projects and channels on the left, a shared message timeline in the center, and the member list on the right.",
    caption: "A place for the whole team. Channels, shared conversations, and project rooms, side by side.",
  },
  {
    label: "Code & review",
    src: "/product/code-review.png",
    width: 1256,
    height: 786,
    alt: "Multiplayer AI’s actual room interface: teammate chats on the left, checkout.js in the code editor, changed files on the right, and Get latest and Publish in the toolbar.",
    caption: "Your code, your teammates, and the changes to review. One shared room.",
  },
  {
    label: "AI conversations",
    src: "/product/ai-conversation.png",
    width: 1256,
    height: 786,
    alt: "A recorded Codex CLI conversation in Multiplayer AI showing a checkout validation request, the agent’s response, changed files, and the repository explorer.",
    caption: "Follow the agent’s work, read its response, and see which files changed.",
  },
  {
    label: "Chat handoff",
    src: "/product/chat-handoff.png",
    width: 1256,
    height: 786,
    alt: "The actual Hand off this chat dialog, with teammate Priya Shah selected and a note explaining where to pick up the checkout validation work.",
    caption: "Choose a teammate and leave a clear next step, with the conversation intact.",
  },
];

export function ProductPreview() {
  const [active, setActive] = useState(0);
  const dialog = useRef<HTMLDialogElement>(null);
  const view = views[active];

  return (
    <figure className={styles.preview}>
      <button
        type="button"
        className={styles.screenshotButton}
        aria-label={`Enlarge screenshot: ${view.label}`}
        onClick={() => dialog.current?.showModal()}
      >
        <Image
          src={view.src}
          alt={view.alt}
          width={view.width}
          height={view.height}
          sizes="(max-width: 760px) 100vw, (max-width: 1240px) 94vw, 1160px"
          className={styles.productScreenshot}
        />
        <span className={styles.expandScreenshot}>View full size ↗</span>
      </button>
      <div className={styles.previewControls}>
        <div role="group" aria-label="Explore screenshots of the app">
          {views.map((item, index) => (
            <button
              type="button"
              key={item.label}
              aria-pressed={active === index}
              onClick={() => setActive(index)}
            >
              <span>0{index + 1}</span> {item.label}
            </button>
          ))}
        </div>
        <span className={styles.previewLabel}>Captured in Multiplayer AI</span>
      </div>
      <figcaption className={styles.screenshotCaption}>
        <p aria-live="polite">{view.caption}</p>
        <span>Actual app interface · Sample project and demo accounts</span>
      </figcaption>
      <dialog
        ref={dialog}
        className={styles.screenshotDialog}
        aria-label={`${view.label} — full-size app screenshot`}
        onClick={(event) => {
          if (event.target === event.currentTarget) dialog.current?.close();
        }}
      >
        <div className={styles.screenshotDialogHeader}>
          <span>{view.label}</span>
          <button type="button" onClick={() => dialog.current?.close()} aria-label="Close screenshot">Close ×</button>
        </div>
        <div className={styles.screenshotDialogBody}>
          <Image src={view.src} alt={view.alt} width={view.width} height={view.height} sizes="1256px" />
        </div>
        <p>Actual app interface · Scroll to explore the screenshot</p>
      </dialog>
    </figure>
  );
}
