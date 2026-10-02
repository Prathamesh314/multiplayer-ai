"use client";

import { useState } from "react";
import { AppScreenshot } from "./AppScreenshot";
import styles from "./marketing.module.css";

const views = [
  {
    label: "Team context",
    src: "/product/team-connections.png",
    width: 1440,
    height: 900,
    alt: "Multiplayer AI’s Connections view with a project selector, a connected Slack channel, and the Discord setup option.",
    caption: "Bring selected Slack and Discord channels into your project’s shared context.",
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
  const view = views[active];

  return (
    <figure className={styles.preview}>
      <AppScreenshot {...view} />
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
    </figure>
  );
}
