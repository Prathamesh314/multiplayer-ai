type IconProps = { className?: string };

const base = "shrink-0";

export function ChevronIcon({ className }: IconProps) {
  return (
    <svg viewBox="0 0 16 16" fill="none" aria-hidden className={`${base} ${className ?? ""}`}>
      <path
        d="M6 4l4 4-4 4"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

export function FolderIcon({ className, open }: IconProps & { open?: boolean }) {
  return (
    <svg viewBox="0 0 16 16" fill="none" aria-hidden className={`${base} ${className ?? ""}`}>
      <path
        d={
          open
            ? "M1.75 12.25V4.5a1 1 0 011-1h3.1l1.4 1.6h5a1 1 0 011 1v.65H4.6L2.4 12.25z"
            : "M1.75 12.25V4.5a1 1 0 011-1h3.1l1.4 1.6h5a1 1 0 011 1v6.15a1 1 0 01-1 1H2.75a1 1 0 01-1-1z"
        }
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinejoin="round"
      />
      {open && (
        <path
          d="M2.4 12.25l2.2-5.6h10.1l-2.2 5.6z"
          stroke="currentColor"
          strokeWidth="1.3"
          strokeLinejoin="round"
        />
      )}
    </svg>
  );
}

export function FileIcon({ className }: IconProps) {
  return (
    <svg viewBox="0 0 16 16" fill="none" aria-hidden className={`${base} ${className ?? ""}`}>
      <path
        d="M9 1.75H4.25a1 1 0 00-1 1v10.5a1 1 0 001 1h7.5a1 1 0 001-1V5.5z"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinejoin="round"
      />
      <path d="M8.9 1.9V5.5h3.7" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" />
    </svg>
  );
}

export function GitBranchIcon({ className }: IconProps) {
  return (
    <svg viewBox="0 0 16 16" fill="none" aria-hidden className={`${base} ${className ?? ""}`}>
      <circle cx="4.5" cy="3.5" r="1.75" stroke="currentColor" strokeWidth="1.3" />
      <circle cx="4.5" cy="12.5" r="1.75" stroke="currentColor" strokeWidth="1.3" />
      <circle cx="11.5" cy="5" r="1.75" stroke="currentColor" strokeWidth="1.3" />
      <path
        d="M4.5 5.25v5.5M11.5 6.75c0 2-1.6 2.9-3.4 3.2-1.4.25-2.6.6-3.4 1.3"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinecap="round"
      />
    </svg>
  );
}

export function FolderUpIcon({ className }: IconProps) {
  return (
    <svg viewBox="0 0 24 24" fill="none" aria-hidden className={`${base} ${className ?? ""}`}>
      <path
        d="M3 18V6.5a1.5 1.5 0 011.5-1.5h4l2 2.5h8A1.5 1.5 0 0120 9v9a1.5 1.5 0 01-1.5 1.5h-14A1.5 1.5 0 013 18z"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinejoin="round"
      />
      <path
        d="M11.5 16.5v-5.5m0 0L9.25 13.25M11.5 11l2.25 2.25"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

export function SearchIcon({ className }: IconProps) {
  return (
    <svg viewBox="0 0 16 16" fill="none" aria-hidden className={`${base} ${className ?? ""}`}>
      <circle cx="7" cy="7" r="4.25" stroke="currentColor" strokeWidth="1.4" />
      <path d="M10.2 10.2l3.05 3.05" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
    </svg>
  );
}

export function SpinnerIcon({ className }: IconProps) {
  return (
    <svg
      viewBox="0 0 16 16"
      fill="none"
      aria-hidden
      className={`${base} animate-spin ${className ?? ""}`}
    >
      <circle cx="8" cy="8" r="6.25" stroke="currentColor" strokeWidth="1.6" opacity="0.25" />
      <path
        d="M14.25 8A6.25 6.25 0 008 1.75"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
      />
    </svg>
  );
}

export function CheckIcon({ className }: IconProps) {
  return (
    <svg viewBox="0 0 16 16" fill="none" aria-hidden className={`${base} ${className ?? ""}`}>
      <path
        d="M3.5 8.5l3 3 6-6.5"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

export function FilesIcon({ className }: IconProps) {
  return (
    <svg viewBox="0 0 24 24" fill="none" aria-hidden className={`${base} ${className ?? ""}`}>
      <path
        d="M14 3H7.5A1.5 1.5 0 006 4.5v13A1.5 1.5 0 007.5 19H16a1.5 1.5 0 001.5-1.5V6.5z"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinejoin="round"
      />
      <path d="M13.9 3.2V6.5h3.4" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" />
      <path
        d="M9 21h9a2 2 0 002-2V9"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        opacity="0.55"
      />
    </svg>
  );
}

export function ChatIcon({ className }: IconProps) {
  return (
    <svg viewBox="0 0 24 24" fill="none" aria-hidden className={`${base} ${className ?? ""}`}>
      <path
        d="M4 6.5A1.5 1.5 0 015.5 5h13A1.5 1.5 0 0120 6.5v8a1.5 1.5 0 01-1.5 1.5H10l-4.2 3.2a.5.5 0 01-.8-.4V16h-.5A1.5 1.5 0 013 14.5v-8z"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinejoin="round"
      />
    </svg>
  );
}

export function SparkleIcon({ className }: IconProps) {
  return (
    <svg viewBox="0 0 24 24" fill="none" aria-hidden className={`${base} ${className ?? ""}`}>
      <path
        d="M12 3l1.6 4.6L18 9.2l-4.4 1.6L12 15.4l-1.6-4.6L6 9.2l4.4-1.6z"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinejoin="round"
      />
      <path
        d="M17.5 15l.75 2.1 2.1.75-2.1.75-.75 2.1-.75-2.1-2.1-.75 2.1-.75z"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinejoin="round"
      />
    </svg>
  );
}

export function UserPlusIcon({ className }: IconProps) {
  return (
    <svg viewBox="0 0 24 24" fill="none" aria-hidden className={`${base} ${className ?? ""}`}>
      <circle cx="10" cy="8" r="3.25" stroke="currentColor" strokeWidth="1.6" />
      <path
        d="M4.25 19.5c0-3 2.6-5 5.75-5 1.3 0 2.5.35 3.45.95"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
      />
      <path
        d="M17.5 14v5.5M14.75 16.75h5.5"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
      />
    </svg>
  );
}

export function TerminalIcon({ className }: IconProps) {
  return (
    <svg viewBox="0 0 24 24" fill="none" aria-hidden className={`${base} ${className ?? ""}`}>
      <rect x="3" y="4.5" width="18" height="15" rx="1.5" stroke="currentColor" strokeWidth="1.5" />
      <path
        d="M7 10l2.5 2.25L7 14.5M12 15h5"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

export function CloseIcon({ className }: IconProps) {
  return (
    <svg viewBox="0 0 16 16" fill="none" aria-hidden className={`${base} ${className ?? ""}`}>
      <path
        d="M4 4l8 8M12 4l-8 8"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
      />
    </svg>
  );
}

export function SendIcon({ className }: IconProps) {
  return (
    <svg viewBox="0 0 16 16" fill="none" aria-hidden className={`${base} ${className ?? ""}`}>
      <path
        d="M2.5 8l11-5-4 12-2.4-5.1z"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinejoin="round"
      />
    </svg>
  );
}

export function LayoutIcon({ className, side }: IconProps & { side: "left" | "right" }) {
  return (
    <svg viewBox="0 0 16 16" fill="none" aria-hidden className={`${base} ${className ?? ""}`}>
      <rect x="2" y="3" width="12" height="10" rx="1.5" stroke="currentColor" strokeWidth="1.3" />
      <path
        d={side === "left" ? "M6 3v10" : "M10 3v10"}
        stroke="currentColor"
        strokeWidth="1.3"
      />
      <rect
        x={side === "left" ? 2.6 : 10}
        y="3.6"
        width="3.4"
        height="8.8"
        fill="currentColor"
        opacity="0.35"
      />
    </svg>
  );
}

export function AlertIcon({ className }: IconProps) {
  return (
    <svg viewBox="0 0 16 16" fill="none" aria-hidden className={`${base} ${className ?? ""}`}>
      <path
        d="M8 2.25l5.75 10.5H2.25z"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinejoin="round"
      />
      <path d="M8 6.25v3" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
      <circle cx="8" cy="11.15" r="0.75" fill="currentColor" />
    </svg>
  );
}
