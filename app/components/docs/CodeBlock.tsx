"use client";
import { useRef, useState } from "react";
import styles from "../../docs/docs.module.css";
export function CodeBlock({ children }: { children: React.ReactNode }) {
  const code = useRef<HTMLPreElement>(null);
  const [message, setMessage] = useState("");
  return <div className={styles.codeBlock}>
    <div><span aria-live="polite">{message || "Terminal command"}</span><button type="button" onClick={async () => {
      try { await navigator.clipboard.writeText(code.current?.textContent ?? ""); setMessage("Copied to clipboard"); }
      catch { setMessage("Select the command and copy it manually"); }
    }}>Copy</button></div>
    <pre ref={code}>{children}</pre>
  </div>;
}
