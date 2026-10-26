/**
 * The Multicode AI mark on its paper tile, the same picture as the favicon
 * and the desktop app icon. The mark's middle faces are near black, so it is
 * never shown bare on a dark surface. All of these are built from
 * public/brand/multicode-mark.png by scripts/brand-icons.mjs.
 */
export function LogoMark({ className, title }: { className?: string; title?: string }) {
  return (
    // eslint-disable-next-line @next/next/no-img-element -- a fixed 128 px asset, shown at icon sizes
    <img src="/brand/multicode-tile.png" width={128} height={128} alt={title ?? ""} aria-hidden={title ? undefined : true}
      draggable={false} className={`shrink-0 select-none ${className ?? ""}`} />
  );
}
