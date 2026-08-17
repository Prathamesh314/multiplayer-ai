import { readDroppedFolder } from "./scan";
import type { ScanSource } from "./types";

/**
 * A folder the user picked but has not scanned yet. Kept as the raw source so
 * the scan can happen where its progress can be shown.
 */
export type PickedSource =
  | { kind: "handle"; handle: FileSystemDirectoryHandle; origin: ScanSource }
  | { kind: "files"; files: File[]; origin: ScanSource };

export function supportsDirectoryPicker(): boolean {
  return typeof window !== "undefined" && !!window.showDirectoryPicker;
}

/** Returns null when the user dismisses the picker. */
export async function pickDirectory(): Promise<PickedSource | null> {
  if (!window.showDirectoryPicker) return null;
  try {
    const handle = await window.showDirectoryPicker({ mode: "read" });
    return { kind: "handle", handle, origin: "picker" };
  } catch (cause) {
    if (cause instanceof DOMException && cause.name === "AbortError") return null;
    throw cause;
  }
}

export function sourceFromFileList(files: FileList | null): PickedSource | null {
  const list = [...(files ?? [])];
  return list.length > 0 ? { kind: "files", files: list, origin: "input" } : null;
}

export async function sourceFromDrop(dataTransfer: DataTransfer): Promise<PickedSource | null> {
  const dropped = await readDroppedFolder(dataTransfer);
  if (!dropped) return null;
  return dropped.kind === "handle"
    ? { kind: "handle", handle: dropped.handle, origin: "drop" }
    : { kind: "files", files: dropped.files, origin: "drop" };
}

/** Folder name and, when known, how many files came with it. */
export function describeSource(source: PickedSource): { name: string; detail: string } {
  if (source.kind === "handle") {
    return { name: source.handle.name || "folder", detail: "ready to scan" };
  }

  const first = source.files[0]?.webkitRelativePath ?? "";
  const slashAt = first.indexOf("/");
  return {
    name: slashAt > 0 ? first.slice(0, slashAt) : "folder",
    detail: `${source.files.length.toLocaleString("en-US")} files`,
  };
}
