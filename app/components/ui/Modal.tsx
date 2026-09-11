"use client";

import { useEffect, useId, useRef } from "react";
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
        className={`vs-scroll fixed inset-0 m-auto max-h-[calc(100dvh-2rem)] w-[calc(100%-2rem)] ${width} overflow-y-auto rounded-2xl border border-vs-border bg-vs-panel p-0 text-vs-fg shadow-[0_24px_64px_rgb(0_0_0_/_0.5)] backdrop:bg-black/60 backdrop:backdrop-blur-sm`}
      >
        <header className="flex items-start gap-3 border-b border-vs-border px-5 py-4">
          <div className="min-w-0 flex-1">
            <h2 className="font-display text-[16px] font-semibold tracking-tight">{title}</h2>
            {description && (
              <p id={descriptionId} className="mt-1 text-[14px] leading-5 text-vs-muted">{description}</p>
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
      <span className="text-[12px] font-semibold uppercase tracking-wider text-vs-muted">
        {label}
      </span>
      {children}
      {hint && <span className="mt-1.5 block text-[12px] text-vs-muted">{hint}</span>}
    </label>
  );
}

export const inputClass =
  "mt-1.5 w-full rounded-lg border border-vs-border bg-vs-editor px-3 py-2 text-base text-vs-fg outline-none placeholder:text-vs-muted focus:border-vs-accent";

export function PrimaryButton({
  children,
  ...props
}: React.ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button
      type="button"
      {...props}
      className="flex items-center justify-center gap-2 rounded-lg bg-vs-accent px-4 py-2 text-sm font-medium text-vs-accent-fg transition hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-60"
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
      className="flex items-center justify-center gap-2 rounded-lg border border-vs-border px-4 py-2 text-sm transition hover:bg-vs-hover disabled:cursor-not-allowed disabled:opacity-60"
    >
      {children}
    </button>
  );
}

export function ErrorNote({ children }: { children: React.ReactNode }) {
  return (
    <p role="alert" className="flex items-start gap-2 rounded-lg border border-vs-danger/40 bg-vs-danger/10 px-3 py-2 text-sm leading-5 text-vs-danger">
      <span aria-hidden>⚠</span>
      {children}
    </p>
  );
}
