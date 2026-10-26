/**
 * Keeps the computer from sleeping while an AI task runs: an hours-long task
 * must not stop because the screen went dark. Started when a turn begins and
 * released when the last running turn ends (turns can run in parallel). The
 * display may still turn off; only system sleep is held off. Each helper also
 * ends by itself if this process dies, so it never outlives the runner.
 *
 * - macOS: caffeinate -i -s -w <pid> (idle and, on power, system sleep).
 * - Windows: a hidden PowerShell holding SetThreadExecutionState until released.
 * - Linux: systemd-inhibit, where systemd is present.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";

let holders = 0;
let helper: ChildProcess | null = null;

function start(): ChildProcess | null {
  const options = { stdio: "ignore" as const, windowsHide: true, detached: false };
  try {
    if (process.platform === "darwin") return spawn("/usr/bin/caffeinate", ["-i", "-s", "-w", String(process.pid)], options);
    if (process.platform === "win32") {
      // ES_CONTINUOUS | ES_SYSTEM_REQUIRED, held until this script ends; it ends with the runner.
      const script = "Add-Type -Namespace MulticodeAI -Name Power -MemberDefinition '[DllImport(\"kernel32.dll\")] public static extern uint SetThreadExecutionState(uint flags);';" +
        "[MulticodeAI.Power]::SetThreadExecutionState(0x80000001) | Out-Null;" +
        `while (Get-Process -Id ${process.pid} -ErrorAction SilentlyContinue) { Start-Sleep -Seconds 20 }`;
      return spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-WindowStyle", "Hidden", "-Command", script], options);
    }
    if (process.platform === "linux") {
      const inhibit = ["/usr/bin/systemd-inhibit", "/bin/systemd-inhibit"].find(path => existsSync(path));
      if (!inhibit) return null;
      return spawn(inhibit, ["--what=idle:sleep", "--who=Multicode AI", "--why=An AI task is running", "--mode=block",
        "/bin/sh", "-c", `while kill -0 ${process.pid} 2>/dev/null; do sleep 20; done`], options);
    }
  } catch {
    // Not available here: the task still runs, the computer may just sleep.
  }
  return null;
}

/** Hold the computer awake; the returned function releases this hold (once). */
export function keepAwake(): () => void {
  if (holders++ === 0) {
    helper = start();
    helper?.on("error", () => { helper = null; });
    helper?.unref();
  }
  let released = false;
  return () => {
    if (released) return;
    released = true;
    if (--holders > 0) return;
    try { helper?.kill(); } catch { /* already gone */ }
    helper = null;
  };
}

/** For tests: whether a hold is active. */
export const awakeHolds = () => holders;
