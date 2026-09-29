"use client";

import Image from "next/image";
import { useRef } from "react";
import styles from "./marketing.module.css";

type Props = {
  src: string;
  alt: string;
  width: number;
  height: number;
  label: string;
  focus?: "team" | "handoff" | "code" | "agent";
};

export function AppScreenshot({ src, alt, width, height, label, focus }: Props) {
  const dialog = useRef<HTMLDialogElement>(null);
  return (
    <>
      <button
        type="button"
        className={`${styles.screenshotButton} ${focus ? styles.featureScreenshot : ""}`}
        data-focus={focus}
        aria-label={`Enlarge screenshot: ${label}`}
        onClick={() => dialog.current?.showModal()}
      >
        {/* Lossless originals keep code and small interface text crisp. */}
        <Image src={src} alt={alt} width={width} height={height} unoptimized className={styles.productScreenshot} />
        <span className={styles.expandScreenshot}>View full size ↗</span>
      </button>
      <dialog ref={dialog} className={styles.screenshotDialog} aria-label={`${label} — full-size app screenshot`}
        onClick={event => { if (event.target === event.currentTarget) dialog.current?.close(); }}>
        <div className={styles.screenshotDialogHeader}>
          <span>{label}</span>
          <button type="button" onClick={() => dialog.current?.close()} aria-label="Close screenshot">Close ×</button>
        </div>
        <div className={styles.screenshotDialogBody} tabIndex={0} aria-label="Full-size screenshot. Scroll to explore.">
          <Image src={src} alt={alt} width={width} height={height} unoptimized />
        </div>
        <p>Actual app interface · Scroll to explore the screenshot</p>
      </dialog>
    </>
  );
}
