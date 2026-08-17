// Ambient types for browser APIs that TypeScript's lib.dom does not ship yet.
import type {} from "react";

declare global {
  interface DirectoryPickerOptions {
    id?: string;
    mode?: "read" | "readwrite";
    startIn?: string | FileSystemHandle;
  }

  interface Window {
    showDirectoryPicker?(
      options?: DirectoryPickerOptions,
    ): Promise<FileSystemDirectoryHandle>;
  }

  interface DataTransferItem {
    getAsFileSystemHandle?(): Promise<FileSystemHandle | null>;
  }
}

declare module "react" {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars -- must match React's signature
  interface InputHTMLAttributes<T> {
    // Non-standard, but the only way to pick a whole folder without the
    // File System Access API.
    webkitdirectory?: string;
    directory?: string;
  }
}
