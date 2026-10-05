"use client";

import { useEffect, useId, useRef } from "react";
import { AlertIcon, CloseIcon } from "../icons";

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
  const dialogRef = useRef<HTMLDialogElement>(null);
  const descriptionId = useId();

  useEffect(() => {
    const dialog = dialogRef.current;
    const previousFocus = document.activeElement;
    dialog?.showModal();
    return () => {
      dialog?.close();
      if (previousFocus instanceof HTMLElement && previousFocus.isConnected) previousFocus.focus();
    };
  }, []);

  return (
      <dialog
        ref={dialogRef}
        aria-modal="true"
        aria-label={title}
        aria-describedby={description ? descriptionId : undefined}
        onCancel={(event) => { event.preventDefault(); onClose(); }}
        onClick={(event) => {
          if (event.target !== event.currentTarget) return;
          const bounds = event.currentTarget.getBoundingClientRect();
          if (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom) onClose();
        }}
        className={`ui-dialog fixed inset-0 m-auto max-h-[calc(100dvh-2rem)] w-[calc(100%-2rem)] ${width} overflow-hidden rounded-2xl border border-vs-border bg-vs-panel p-0 text-vs-fg shadow-[0_24px_64px_rgb(0_0_0_/_0.5)] backdrop:bg-black/60 backdrop:backdrop-blur-sm`}
      >
        <header className="flex items-start gap-4 border-b border-vs-border px-5 py-5 sm:px-6">
          <div className="min-w-0 flex-1">
            <h2 className="font-display text-xl font-semibold tracking-tight">{title}</h2>
            {description && (
              <p id={descriptionId} className="mt-2 text-sm leading-6 text-vs-muted">{description}</p>
            )}
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label={`Close ${title}`}
            className="-mr-1 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-vs-muted transition hover:bg-vs-hover hover:text-vs-fg"
          >
            <CloseIcon className="h-4 w-4" />
          </button>
        </header>

        <div className="ui-dialog-body vs-scroll space-y-5 px-5 py-5 sm:px-6">{children}</div>

        {footer && (
          <footer className="flex flex-wrap items-center justify-end gap-3 border-t border-vs-border bg-vs-editor/40 px-5 py-4 sm:px-6">
            {footer}
          </footer>
        )}
      </dialog>
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
      <span className="text-sm font-medium text-vs-fg">
        {label}
      </span>
      {children}
      {hint && <span className="mt-2 block text-xs leading-5 text-vs-muted">{hint}</span>}
    </label>
  );
}

export const inputClass =
  "mt-2 min-h-11 w-full rounded-lg border border-vs-border bg-vs-editor px-3 py-2.5 text-base text-vs-fg outline-none placeholder:text-vs-muted focus:border-vs-accent";

export function PrimaryButton({
  children,
  className = "",
  ...props
}: React.ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button
      type="button"
      {...props}
      className={`inline-flex min-h-10 items-center justify-center gap-2 rounded-lg bg-vs-accent px-4 py-2.5 text-sm font-semibold text-vs-accent-fg transition hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50 ${className}`}
    >
      {children}
    </button>
  );
}

export function GhostButton({
  children,
  className = "",
  ...props
}: React.ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button
      type="button"
      {...props}
      className={`inline-flex min-h-10 items-center justify-center gap-2 rounded-lg border border-vs-border px-4 py-2.5 text-sm font-medium transition hover:border-vs-muted/50 hover:bg-vs-hover disabled:cursor-not-allowed disabled:opacity-50 ${className}`}
    >
      {children}
    </button>
  );
}

export function ErrorNote({ children, announce = true }: { children: React.ReactNode; announce?: boolean }) {
  return (
    <p role={announce ? "alert" : undefined} className="flex items-start gap-2.5 rounded-xl border border-vs-danger/25 bg-vs-danger/5 px-3.5 py-3 text-sm leading-6 text-vs-danger">
      <AlertIcon className="mt-0.5 h-4 w-4 shrink-0" />
      <span>{children}</span>
    </p>
  );
}
