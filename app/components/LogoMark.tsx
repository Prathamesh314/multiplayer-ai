/**
 * The Multicode AI mark: two wide blocks over a three-by-four grid. Drawn in the
 * current text colour, so it suits any surface; the favicon and the desktop
 * app icon use the same geometry on black (app/icon.svg, desktop/icon.svg).
 */
export function LogoMark({ className, title }: { className?: string; title?: string }) {
  return (
    <svg viewBox="143 159 738 706" className={className} fill="currentColor" role={title ? "img" : undefined} aria-hidden={title ? undefined : true} aria-label={title}>
      <rect x="254" y="167" width="226" height="106" />
      <rect x="543" y="167" width="226" height="106" />
      <rect x="151" y="319" width="148" height="107" />
      <rect x="438" y="319" width="148" height="107" />
      <rect x="725" y="319" width="148" height="107" />
      <rect x="151" y="463" width="148" height="107" />
      <rect x="438" y="463" width="148" height="107" />
      <rect x="725" y="463" width="148" height="107" />
      <rect x="151" y="607" width="148" height="107" />
      <rect x="438" y="607" width="148" height="107" />
      <rect x="725" y="607" width="148" height="107" />
      <rect x="151" y="750" width="148" height="107" />
      <rect x="438" y="750" width="148" height="107" />
      <rect x="725" y="750" width="148" height="107" />
    </svg>
  );
}
