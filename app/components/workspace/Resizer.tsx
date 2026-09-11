"use client";

type ResizerProps = {
  width: number;
  onResize: (width: number) => void;
  min?: number;
  max?: number;
  /** Right-hand panels grow when the pointer moves left. */
  invert?: boolean;
};

/** One-pixel drag handle between workspace panes. */
export function Resizer({ width, onResize, min = 180, max = 560, invert }: ResizerProps) {
  function onPointerDown(event: React.PointerEvent<HTMLDivElement>) {
    event.preventDefault();
    const startX = event.clientX;
    const startWidth = width;

    const move = (moveEvent: PointerEvent) => {
      const delta = (invert ? -1 : 1) * (moveEvent.clientX - startX);
      onResize(Math.min(max, Math.max(min, startWidth + delta)));
    };
    const stop = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", stop);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    };

    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", stop);
  }

  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label="Resize workspace panel"
      aria-valuemin={min}
      aria-valuemax={max}
      aria-valuenow={width}
      tabIndex={0}
      onKeyDown={event => {
        if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
        event.preventDefault();
        const direction = (event.key === "ArrowRight" ? 1 : -1) * (invert ? -1 : 1);
        onResize(Math.min(max, Math.max(min, width + direction * 24)));
      }}
      onPointerDown={onPointerDown}
      className="relative w-px shrink-0 cursor-col-resize bg-vs-border transition-colors hover:bg-vs-accent"
    >
      {/* Widen the grab target without widening the visible line. */}
      <span className="absolute inset-y-0 -left-1 -right-1" />
    </div>
  );
}
