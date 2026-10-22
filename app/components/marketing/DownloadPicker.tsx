"use client";

/*
 * One button for the visitor's own computer, then how to install it in a few
 * steps. The operating system comes from the browser; on a Mac the processor
 * comes from Client Hints where offered (Chromium) and the GPU name otherwise
 * (Safari), defaulting to Apple Silicon, which nearly every current Mac is.
 */

import { useEffect, useState } from "react";
import styles from "./marketing.module.css";

export type DownloadKey = "mac-arm64" | "mac-x64" | "win-x64" | "linux-x64";
export type DownloadOption = { key: DownloadKey; os: "macOS" | "Windows" | "Linux"; label: string; href: string | null };

async function detect(): Promise<DownloadKey | null> {
  type Hints = { platform?: string; getHighEntropyValues?: (hints: string[]) => Promise<{ architecture?: string }> };
  const data = (navigator as Navigator & { userAgentData?: Hints }).userAgentData;
  const platform = `${data?.platform ?? ""} ${navigator.platform} ${navigator.userAgent}`.toLowerCase();
  if (/android|iphone|ipad/.test(platform)) return null;
  if (/win/.test(platform)) return "win-x64";
  if (/mac/.test(platform)) {
    try {
      const hints = await data?.getHighEntropyValues?.(["architecture"]);
      if (hints?.architecture) return hints.architecture === "arm" ? "mac-arm64" : "mac-x64";
    } catch { /* not offered */ }
    try {
      const gl = document.createElement("canvas").getContext("webgl");
      const info = gl?.getExtension("WEBGL_debug_renderer_info");
      const renderer = info && gl ? String(gl.getParameter(info.UNMASKED_RENDERER_WEBGL)) : "";
      if (/apple (m\d|gpu)/i.test(renderer)) return "mac-arm64";
      if (/intel|amd|radeon/i.test(renderer)) return "mac-x64";
    } catch { /* no WebGL */ }
    return "mac-arm64";
  }
  if (/linux|x11|cros/.test(platform)) return "linux-x64";
  return null;
}

export function DownloadPicker({ options, preview, address }: { options: DownloadOption[]; preview: boolean; address: string }) {
  const [detected, setDetected] = useState<DownloadKey | null>(null);
  const [chosen, setChosen] = useState<DownloadKey | null>(null);
  const [started, setStarted] = useState(false);
  useEffect(() => { void detect().then(setDetected); }, []);

  const current = options.find((option) => option.key === (chosen ?? detected)) ?? null;
  const others = options.filter((option) => option.key !== current?.key && option.href);
  if (!options.some((option) => option.href)) return null;

  return (
    <div className={styles.picker}>
      <div className={styles.pickerMain}>
        <p className={styles.pickerKicker}>{current && !chosen ? "Recommended for your computer" : "Download"}</p>
        {current?.href ? (
          <a href={current.href} onClick={() => setStarted(true)} className={styles.pickerButton}>
            Download for {current.os} <span>· {current.label}</span>
            <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M8 2v9m0 0 3.5-3.5M8 11 4.5 7.5M3 14h10" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" /></svg>
          </a>
        ) : (
          <p className={styles.pickerHint}>Choose your computer below.</p>
        )}
        {others.length > 0 && (
          <p className={styles.pickerOthers}>
            {current ? "Not your computer? " : ""}
            {others.map((option, index) => (
              <span key={option.key}>{index > 0 && " · "}<button type="button" onClick={() => { setChosen(option.key); setStarted(false); }}>{option.os} {option.label}</button></span>
            ))}
          </p>
        )}
      </div>
      {current && (
        <ol className={`${styles.installSteps} ${started ? styles.installStarted : ""}`} aria-label={`Install on ${current.os}`}>
          {steps(current, preview, address).map((step, index) => (
            <li key={index}><span aria-hidden="true">{index + 1}</span><div><strong>{step.title}</strong>{step.body && <p>{step.body}</p>}</div></li>
          ))}
        </ol>
      )}
    </div>
  );
}

function steps(option: DownloadOption, preview: boolean, address: string): { title: string; body?: React.ReactNode }[] {
  const signIn = { title: "Sign in", body: <>Use your Multicode AI account. Your computer connects by itself. If the app asks for a workspace address, enter <code>{address}</code>.</> };
  if (option.os === "macOS") return [
    { title: "Open the download and drag Multicode AI to Applications" },
    { title: "Open Multicode AI from Applications", body: preview ? <>If macOS says <em>“Apple could not verify…”</em>, click <strong>Done</strong>, open <strong>System Settings → Privacy &amp; Security</strong>, scroll down and click <strong>Open Anyway</strong>, then <strong>Open</strong>. You only do this once.</> : undefined },
    signIn,
  ];
  if (option.os === "Windows") return [
    { title: "Run the installer", body: preview ? <>If <em>“Windows protected your PC”</em> appears, click <strong>More info → Run anyway</strong>. You only do this once.</> : undefined },
    { title: "Open Multicode AI from the Start menu" },
    signIn,
  ];
  return [
    { title: "Allow the AppImage to run", body: <>Right-click it → <strong>Properties → Allow executing as program</strong>, or run <code>chmod +x Multicode-AI-*.AppImage</code>.</> },
    { title: "Open it" },
    signIn,
  ];
}
