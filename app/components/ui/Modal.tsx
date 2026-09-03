"use client";

import { useEffect } from "react";
import { CloseIcon } from "../icons";

type ModalProps = {
  title: string;
  description?: string;
  onClose: () => void;
  children: React.ReactNode;
  footer?: React.ReactNode;
  /** Tailwind max-width class. */
  width?: string;
};

export function Modal({
  title,
  description,
  onClose,
  children,
  footer,
  width = "max-w-lg",
}: ModalProps) {
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/55 p-4 backdrop-blur-sm sm:items-center sm:p-6"
      onClick={onClose}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label={title}
        onClick={(event) => event.stopPropagation()}
        className={`w-full ${width} overflow-hidden rounded-2xl border border-vs-border bg-vs-panel text-vs-fg shadow-2xl`}
      >
        <header className="flex items-start gap-3 border-b border-vs-border px-5 py-4">
          <div className="min-w-0 flex-1">
            <h2 className="font-display text-[15px] font-semibold tracking-tight">{title}</h2>
            {description && (
              <p className="mt-1 text-[13px] leading-5 text-vs-muted">{description}</p>
            )}
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label={`Close ${title}`}
            className="-mr-1 rounded p-1 text-vs-muted transition hover:bg-vs-hover hover:text-vs-fg"
          >
            <CloseIcon className="h-4 w-4" />
          </button>
        </header>

        <div className="space-y-4 px-5 py-4">{children}</div>

        {footer && (
          <footer className="flex items-center justify-end gap-2 border-t border-vs-border bg-vs-editor/40 px-5 py-3.5">
            {footer}
          </footer>
        )}
      </div>
    </div>
  );
}

export function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <label className="block">
      <span className="text-[11px] font-semibold uppercase tracking-wider text-vs-muted">
        {label}
      </span>
      {children}
      {hint && <span className="mt-1.5 block text-[11px] text-vs-muted">{hint}</span>}
    </label>
  );
}

export const inputClass =
  "mt-1.5 w-full rounded-lg border border-vs-border bg-vs-editor px-3 py-2 text-sm text-vs-fg outline-none placeholder:text-vs-muted focus:border-vs-accent";

export function PrimaryButton({
  children,
  ...props
}: React.ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button
      type="button"
      {...props}
      className="flex items-center justify-center gap-2 rounded-lg bg-vs-accent px-4 py-2 text-sm font-medium text-vs-accent-fg transition hover:opacity-90 disabled:opacity-60"
    >
      {children}
    </button>
  );
}

export function GhostButton({
  children,
  ...props
}: React.ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button
      type="button"
      {...props}
      className="flex items-center justify-center gap-2 rounded-lg border border-vs-border px-4 py-2 text-sm transition hover:bg-vs-hover disabled:opacity-60"
    >
      {children}
    </button>
  );
}

export function ErrorNote({ children }: { children: React.ReactNode }) {
  return (
    <p className="flex items-start gap-2 rounded-lg border border-red-500/40 bg-red-500/10 px-3 py-2 text-xs leading-5 text-red-600 dark:text-red-300">
      <span aria-hidden>⚠</span>
      {children}
    </p>
  );
}
