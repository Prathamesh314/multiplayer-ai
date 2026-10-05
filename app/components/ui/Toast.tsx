"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { AlertIcon, CheckIcon, CloseIcon } from "../icons";

type Notice = { title: string; description?: string; tone?: "success" | "error" };
const ToastContext = createContext<((notice: Notice) => void) | null>(null);

export function ToastProvider({ children }: { children: React.ReactNode }) {
  const [notice, setNotice] = useState<(Notice & { id: number }) | null>(null);
  const sequence = useRef(0);
  const notify = useCallback((next: Notice) => setNotice({ ...next, id: ++sequence.current }), []);
  const dismiss = useCallback(() => setNotice(null), []);
  return <ToastContext.Provider value={notify}>
    {children}
    <section aria-label="Notifications" className="pointer-events-none fixed inset-x-4 top-[max(1rem,env(safe-area-inset-top))] z-[100] mx-auto max-w-sm sm:left-auto sm:right-6 sm:top-6 sm:mx-0 sm:w-96">
      {notice && <Toast key={notice.id} notice={notice} dismiss={dismiss} />}
    </section>
  </ToastContext.Provider>;
}

function Toast({ notice, dismiss }: { notice: Notice; dismiss: () => void }) {
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);
  const isError = notice.tone === "error";
  const remaining = useRef(isError ? 9000 : 6000);
  useEffect(() => {
    if (hovered || focused) return;
    const started = Date.now();
    const timer = setTimeout(dismiss, remaining.current);
    return () => { clearTimeout(timer); remaining.current = Math.max(0, remaining.current - (Date.now() - started)); };
  }, [hovered, focused, dismiss]);
  const Icon = isError ? AlertIcon : CheckIcon;
  return <div data-toast role={isError ? "alert" : "status"} aria-atomic="true"
    onMouseEnter={() => setHovered(true)} onMouseLeave={() => setHovered(false)}
    onFocus={() => setFocused(true)} onBlur={event => { if (!event.currentTarget.contains(event.relatedTarget)) setFocused(false); }}
    className="pointer-events-auto flex items-start gap-3 rounded-2xl border border-vs-border bg-vs-panel p-4 text-vs-fg shadow-[0_12px_40px_var(--vs-shadow)] motion-safe:animate-[dialog-enter_160ms_ease-out]">
    <span className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-xl ${isError ? "bg-vs-danger/10 text-vs-danger" : "bg-vs-success/10 text-vs-success"}`}><Icon className="h-5 w-5" /></span>
    <div className="min-w-0 flex-1 pt-0.5"><p className="text-sm font-semibold leading-5">{notice.title}</p>{notice.description && <p className="mt-1 break-words text-sm leading-5 text-vs-muted">{notice.description}</p>}</div>
    <button type="button" onClick={dismiss} aria-label="Dismiss notification" className="-mr-1 -mt-1 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-vs-muted transition hover:bg-vs-hover hover:text-vs-fg focus-visible:outline-2 focus-visible:outline-vs-accent"><CloseIcon className="h-4 w-4" /></button>
  </div>;
}

export function useToast() {
  const notify = useContext(ToastContext);
  if (!notify) throw new Error("useToast requires ToastProvider");
  return useMemo(() => ({ notify }), [notify]);
}
