"use client";

import { useState } from "react";
import { screenshots } from "../../docs/screenshots";
import { AppScreenshot } from "./AppScreenshot";
import styles from "./marketing.module.css";

// In the order work happens: a teammate joins, an agent works, the team reviews, then hands off or publishes.
const views = [
  {
    ...screenshots["invite-team"],
    label: "Invite your team",
    caption: "Invite teammates to your team, then add them to a project to give them a room in it.",
  },
  {
    ...screenshots.conversation,
    label: "AI conversations",
    caption: "Follow the agent’s work, read its response, and see which files changed.",
  },
  {
    ...screenshots.changes,
    label: "Code & review",
    caption: "Your code, your teammates, and the changes to review. One shared room.",
  },
  {
    ...screenshots.handoff,
    label: "Chat handoff",
    caption: "Choose a teammate and leave a clear next step, with the conversation intact.",
  },
];

export function ProductPreview() {
  const [active, setActive] = useState(0);
  const view = views[active];

  return (
    <figure className={styles.preview}>
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
        <span className={styles.previewLabel}>Captured in Multicode AI</span>
      </div>
      <AppScreenshot {...view} />
      <figcaption className={styles.screenshotCaption}>
        <p aria-live="polite">{view.caption}</p>
        <span>Actual app interface · Sample project and demo accounts</span>
      </figcaption>
    </figure>
  );
}
