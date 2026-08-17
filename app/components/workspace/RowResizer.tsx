"use client";

type RowResizerProps = {
  height: number;
  onResize: (height: number) => void;
  min?: number;
  max?: number;
};

/** Drag handle for the bottom panel; taller drag as the pointer moves up. */
export function RowResizer({ height, onResize, min = 120, max = 720 }: RowResizerProps) {
  function onPointerDown(event: React.PointerEvent<HTMLDivElement>) {
    event.preventDefault();
    const startY = event.clientY;
    const startHeight = height;

    const move = (moveEvent: PointerEvent) => {
      onResize(Math.min(max, Math.max(min, startHeight - (moveEvent.clientY - startY))));
    };
    const stop = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", stop);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    };

    document.body.style.cursor = "row-resize";
    document.body.style.userSelect = "none";
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", stop);
  }

  return (
    <div
      role="separator"
      aria-orientation="horizontal"
      onPointerDown={onPointerDown}
      className="relative h-px shrink-0 cursor-row-resize bg-vs-border transition-colors hover:bg-vs-accent"
    >
      <span className="absolute inset-x-0 -top-1 -bottom-1" />
    </div>
  );
}
