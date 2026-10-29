"use client";

/*
 * Install with one command, per operating system. A download made from a
 * terminal is not marked as coming from the internet, so macOS and Windows
 * open the app without the unsigned-app warning; the scripts verify every file
 * against the published SHA-256 checksums before installing it.
 */

import { useEffect, useState } from "react";
import styles from "./marketing.module.css";

export type InstallTarget = "mac-arm64" | "mac-x64" | "windows" | "linux";
export type DirectDownload = { label: string; href: string | null };

const TABS: { key: InstallTarget; label: string; where: string }[] = [
  { key: "mac-arm64", label: "macOS · Apple Silicon", where: "Open Terminal (Applications → Utilities) and run:" },
  { key: "mac-x64", label: "macOS · Intel", where: "Open Terminal (Applications → Utilities) and run:" },
  { key: "windows", label: "Windows", where: "Open PowerShell (Start → type “PowerShell”) and run:" },
  { key: "linux", label: "Linux", where: "Open a terminal and run:" },
];

export function installCommand(target: InstallTarget, site: string): string {
  if (target === "windows") return `irm ${site}/install.ps1 | iex`;
  return `curl -fsSL ${site}/install.sh | sh -s -- ${target}`;
}

async function detect(): Promise<InstallTarget | null> {
  type Hints = { platform?: string; getHighEntropyValues?: (hints: string[]) => Promise<{ architecture?: string }> };
  const data = (navigator as Navigator & { userAgentData?: Hints }).userAgentData;
  const platform = `${data?.platform ?? ""} ${navigator.platform} ${navigator.userAgent}`.toLowerCase();
  if (/android|iphone|ipad/.test(platform)) return null;
  if (/win/.test(platform)) return "windows";
  if (/mac/.test(platform)) {
    try {
      const hints = await data?.getHighEntropyValues?.(["architecture"]);
      if (hints?.architecture) return hints.architecture === "arm" ? "mac-arm64" : "mac-x64";
    } catch { /* not offered */ }
    try {
      // Safari hides the processor; the GPU name tells Apple chips from Intel.
      const gl = document.createElement("canvas").getContext("webgl");
      const info = gl?.getExtension("WEBGL_debug_renderer_info");
      const renderer = info && gl ? String(gl.getParameter(info.UNMASKED_RENDERER_WEBGL)) : "";
      if (/intel|amd|radeon/i.test(renderer)) return "mac-x64";
    } catch { /* no WebGL */ }
    return "mac-arm64";
  }
  if (/linux|x11|cros/.test(platform)) return "linux";
  return null;
}

export function InstallCommands({ site, available, downloads }: { site: string; available: boolean; downloads: DirectDownload[] }) {
  const [target, setTarget] = useState<InstallTarget>("mac-arm64");
  const [detected, setDetected] = useState<InstallTarget | null>(null);
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    void detect().then((found) => { if (found) { setDetected(found); setTarget(found); } });
  }, []);

  const tab = TABS.find((item) => item.key === target)!;
  const command = installCommand(target, site);
  function copy() {
    void navigator.clipboard.writeText(command).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1600); }).catch(() => {});
  }

  return (
    <div className={styles.install}>
      <div className={styles.installHead}>
        <div>
          <p className={styles.pickerKicker}>Install with one command</p>
          <p className={styles.installLead}>Installs and opens Multicode AI. Every file is checked against its published checksum first. The preview app isn’t code-signed yet; installing from the terminal skips the one-time “unverified app” prompt a browser download shows.</p>
        </div>
      </div>
      <div role="tablist" aria-label="Your computer" className={styles.installTabs}>
        {TABS.map((item) => (
          <button key={item.key} type="button" role="tab" aria-selected={item.key === target} onClick={() => { setTarget(item.key); setCopied(false); }}
            className={item.key === target ? styles.installTabActive : styles.installTab}>
            {item.label}{item.key === detected && <span className={styles.installYours}>Your computer</span>}
          </button>
        ))}
      </div>
      {available ? (
        <div role="tabpanel" aria-label={tab.label} className={styles.installPanel}>
          <p className={styles.installWhere}>{tab.where}</p>
          <div className={styles.terminal}>
            <code><span aria-hidden="true">{target === "windows" ? "PS>" : "$"}</span> {command}</code>
            <button type="button" onClick={copy} aria-label={`Copy the ${tab.label} install command`}>{copied ? "Copied" : "Copy"}</button>
          </div>
          <ol className={styles.installSteps} aria-label="What happens next">
            <li><span aria-hidden="true">1</span><div><strong>{target === "linux" ? "It installs Multicode AI" : "It downloads, verifies and installs Multicode AI"}</strong><p>{target === "linux" ? "On Ubuntu and Debian it installs the package (you may be asked for your password); elsewhere it installs the AppImage in your home folder." : target === "windows" ? "Just for you: no administrator rights needed." : "Into Applications, replacing an older version."}</p></div></li>
            <li><span aria-hidden="true">2</span><div><strong>Multicode AI opens</strong><p>Next time, open it from {target === "windows" ? "the Start menu" : target === "linux" ? "your applications" : "Applications or Launchpad"}. Run the same command to update.</p></div></li>
            <li><span aria-hidden="true">3</span><div><strong>Sign in</strong><p>Use your Multicode AI account; your computer connects by itself.</p></div></li>
          </ol>
        </div>
      ) : (
        <p className={styles.pickerHint}>Installers are coming soon. Meanwhile, use Multicode AI in your browser.</p>
      )}
      {downloads.some((item) => item.href) && (
        <details className={styles.installDirect} aria-label="Regular downloads">
          <summary>Prefer a regular download?</summary>
          <p>{downloads.filter((item) => item.href).map((item, index) => (
            <span key={item.label}>{index > 0 && " · "}<a href={item.href!}>{item.label}</a></span>
          ))}</p>
          <p className={styles.installNote}>Downloaded in a browser, an unsigned app asks once before it opens: on a Mac, click <strong>Done</strong>, then <strong>System Settings → Privacy &amp; Security → Open Anyway</strong>; on Windows, <strong>More info → Run anyway</strong>. The command above avoids this.</p>
        </details>
      )}
    </div>
  );
}
