"use client";

import Link from "next/link";
import { useRef } from "react";
import styles from "./marketing.module.css";

export function MobileNavigation() {
  const menu = useRef<HTMLDetailsElement>(null);

  return (
    <details
      ref={menu}
      className={styles.mobileMenu}
      onKeyDown={(event) => {
        if (event.key === "Escape" && menu.current?.open) {
          menu.current.open = false;
          menu.current.querySelector("summary")?.focus();
        }
      }}
    >
      <summary aria-label="Open navigation"><span /><span /><span /></summary>
      <nav
        aria-label="Mobile navigation"
        onClick={(event) => {
          if ((event.target as HTMLElement).closest("a") && menu.current) {
            menu.current.open = false;
          }
        }}
      >
        <a href="#product">Product</a>
        <a href="#how-it-works">How it works</a>
        <Link href="/docs">Docs</Link>
        <a href="#faq">FAQ</a>
        <a href="#download">Download</a>
        <Link href="/workspace">Open workspace</Link>
      </nav>
    </details>
  );
}
