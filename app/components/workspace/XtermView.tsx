"use client";

import { forwardRef, useEffect, useImperativeHandle, useRef } from "react";
import "@xterm/xterm/css/xterm.css";
import { killPty, postPtyInput, postPtyResize } from "../../lib/terminal/client";

export type XtermHandle = { clear: () => void; focus: () => void };

/**
 * A real terminal for one tab: xterm.js in the browser, a PTY on the server.
 *
 * Output streams in over SSE (base64-framed) and is written straight to the
 * emulator; keystrokes — including Tab, arrows and Ctrl-C — go back as raw
 * bytes over POST. The emulator, not this component, owns the prompt, history,
 * colours and cwd, which is what makes vim/top/REPLs and completion work.
 */
export const XtermView = forwardRef<XtermHandle, { id: string }>(function XtermView({ id }, ref) {
  const hostRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<{ clear: () => void; focus: () => void } | null>(null);

  useImperativeHandle(ref, () => ({
    clear: () => termRef.current?.clear(),
    focus: () => termRef.current?.focus(),
  }));

  useEffect(() => {
    let disposed = false;
    let cleanup = () => {};

    void (async () => {
      const [{ Terminal }, { FitAddon }] = await Promise.all([
        import("@xterm/xterm"),
        import("@xterm/addon-fit"),
      ]);
      if (disposed || !hostRef.current) return;

      const css = getComputedStyle(hostRef.current);
      const v = (name: string, fallback: string) => css.getPropertyValue(name).trim() || fallback;

      const term = new Terminal({
        cursorBlink: true,
        fontFamily:
          'ui-monospace, SFMono-Regular, Menlo, Monaco, "Cascadia Code", "Roboto Mono", monospace',
        fontSize: 14.5,
        scrollback: 10_000,
        theme: {
          background: v("--vs-terminal", "#0b0e14"),
          foreground: v("--vs-fg", "#cccccc"),
          cursor: v("--vs-accent", "#0078d4"),
        },
      });
      const fit = new FitAddon();
      term.loadAddon(fit);
      term.open(hostRef.current);
      fit.fit();
      term.focus();
      termRef.current = { clear: () => term.clear(), focus: () => term.focus() };

      const source = new EventSource(
        `/api/terminal/pty?id=${encodeURIComponent(id)}&cols=${term.cols}&rows=${term.rows}`,
      );
      source.onmessage = (event) => {
        // base64 → bytes → straight into the emulator.
        term.write(Uint8Array.from(atob(event.data), (c) => c.charCodeAt(0)));
      };
      source.addEventListener("exit", () => {
        term.write("\r\n\x1b[2m[process exited — close this tab]\x1b[0m\r\n");
        source.close();
      });

      const onData = term.onData((data) => postPtyInput(id, data));

      let resizeTimer: ReturnType<typeof setTimeout> | null = null;
      const observer = new ResizeObserver(() => {
        if (resizeTimer) clearTimeout(resizeTimer);
        resizeTimer = setTimeout(() => {
          try {
            fit.fit();
            postPtyResize(id, term.cols, term.rows);
          } catch {
            // The panel can be mid-collapse; the next observation corrects it.
          }
        }, 80);
      });
      observer.observe(hostRef.current);

      cleanup = () => {
        if (resizeTimer) clearTimeout(resizeTimer);
        observer.disconnect();
        onData.dispose();
        source.close();
        term.dispose();
        killPty(id);
      };
    })();

    return () => {
      disposed = true;
      cleanup();
    };
  }, [id]);

  return <div ref={hostRef} className="min-h-0 flex-1 overflow-hidden px-2 py-1.5" />;
});
