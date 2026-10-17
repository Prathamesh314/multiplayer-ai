"use client";

import { useMemo, useRef, useState } from "react";
import type { TreeNode } from "../../lib/types";
import { humanBytes } from "../../lib/format";
import { ADD_FILE_MAX_BYTES, FilesExistError } from "../../lib/session/remote";
import { FileIcon, FolderPlusIcon, FolderUpIcon, SpinnerIcon } from "../icons";
import { GhostButton, Modal, PrimaryButton, inputClass } from "../ui/Modal";

export type AddFilesFn = (files: { path: string; file: Blob }[], overwrite: boolean) => Promise<{ added: string[]; replaced: string[] }>;

const trimFolder = (folder: string) => folder.trim().replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
const join = (folder: string, name: string) => [trimFolder(folder), name.replace(/^\/+/, "")].filter(Boolean).join("/");
const parentOf = (path: string | null) => (path && path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "");

function existingPaths(node: TreeNode, into = new Map<string, "file" | "dir">()) {
  if (node.path) into.set(node.path, node.type);
  for (const child of node.children ?? []) existingPaths(child, into);
  return into;
}

/**
 * VS Code–style adding in the explorer: New file, New folder, Upload files
 * (several at once, any type) and drag-and-drop. New things go into the open
 * file's folder by default, and the path can be edited. Files that already
 * exist are listed and replaced only after the person confirms.
 */
export function useAddFiles({ root, activePath, onAdd, onOpenFile, onExpand }: {
  root: TreeNode; activePath: string | null; onAdd: AddFilesFn;
  onOpenFile: (path: string) => void; onExpand: (folder: string) => void;
}) {
  const existing = useMemo(() => existingPaths(root), [root]);
  const picker = useRef<HTMLInputElement>(null);
  const [creating, setCreating] = useState<{ kind: "file" | "folder"; value: string } | null>(null);
  const [upload, setUpload] = useState<{ files: File[]; folder: string; confirmReplace: boolean } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [dragging, setDragging] = useState(false);

  const startCreate = (kind: "file" | "folder") => {
    setError("");
    const folder = parentOf(activePath);
    setCreating({ kind, value: folder ? `${folder}/` : "" });
  };
  const openUpload = (files: File[]) => {
    if (!files.length) return;
    setError("");
    setUpload({ files, folder: parentOf(activePath), confirmReplace: false });
  };

  async function submitCreate() {
    if (!creating || busy) return;
    const path = trimFolder(creating.value);
    if (!path) return setError(creating.kind === "file" ? "Enter a file name." : "Enter a folder name.");
    if (existing.has(path)) return setError(`${path} already exists.`);
    setBusy(true); setError("");
    try {
      // Git keeps folders through their files, so a new folder holds a .gitkeep.
      const target = creating.kind === "file" ? path : `${path}/.gitkeep`;
      await onAdd([{ path: target, file: new Blob([]) }], false);
      setCreating(null);
      if (creating.kind === "file") onOpenFile(path); else onExpand(path);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not create it.");
    } finally { setBusy(false); }
  }

  const planned = upload ? upload.files.map((file) => ({ file, path: join(upload.folder, file.name), tooBig: file.size > ADD_FILE_MAX_BYTES })) : [];
  const sendable = planned.filter((item) => !item.tooBig);
  const conflicts = sendable.filter((item) => existing.get(item.path) === "file").map((item) => item.path);
  const blockedByFolder = sendable.filter((item) => existing.get(item.path) === "dir").map((item) => item.path);

  async function submitUpload() {
    if (!upload || busy || !sendable.length || blockedByFolder.length) return;
    if (conflicts.length && !upload.confirmReplace) { setUpload({ ...upload, confirmReplace: true }); return; }
    setBusy(true); setError("");
    try {
      const { added, replaced } = await onAdd(sendable.map(({ path, file }) => ({ path, file })), conflicts.length > 0);
      setUpload(null);
      if (upload.folder) onExpand(trimFolder(upload.folder));
      const paths = [...added, ...replaced];
      if (paths.length === 1) onOpenFile(paths[0]);
    } catch (cause) {
      if (cause instanceof FilesExistError) { setUpload({ ...upload, confirmReplace: true }); setError(`${cause.paths.join(", ")} already exist${cause.paths.length === 1 ? "s" : ""}.`); }
      else setError(cause instanceof Error ? cause.message : "Could not add these files.");
    } finally { setBusy(false); }
  }

  const toolbar = (
    <span className="ml-1 flex shrink-0 items-center gap-0.5 normal-case">
      <ToolButton label="New file" onClick={() => startCreate("file")}><FileIcon className="h-3.5 w-3.5" /><span aria-hidden className="-ml-1 text-[10px] font-bold">+</span></ToolButton>
      <ToolButton label="New folder" onClick={() => startCreate("folder")}><FolderPlusIcon className="h-3.5 w-3.5" /></ToolButton>
      <ToolButton label="Upload files" onClick={() => picker.current?.click()}><FolderUpIcon className="h-3.5 w-3.5" /></ToolButton>
      <input ref={picker} type="file" multiple hidden aria-label="Choose files to upload"
        onChange={(event) => { const files = Array.from(event.target.files ?? []); event.target.value = ""; openUpload(files); }} />
    </span>
  );

  const inline = creating && (
    <form className="mx-2 mb-1.5" onSubmit={(event) => { event.preventDefault(); void submitCreate(); }}>
      <label className="flex items-center gap-1.5 rounded border border-vs-accent bg-vs-editor px-2 py-1">
        {creating.kind === "file" ? <FileIcon className="h-3.5 w-3.5 shrink-0 text-vs-muted" /> : <FolderPlusIcon className="h-3.5 w-3.5 shrink-0 text-vs-muted" />}
        <input autoFocus value={creating.value} disabled={busy} aria-label={creating.kind === "file" ? "New file path" : "New folder path"}
          placeholder={creating.kind === "file" ? "data/report.csv" : "data"}
          onChange={(event) => setCreating({ ...creating, value: event.target.value })}
          onKeyDown={(event) => { if (event.key === "Escape") { setCreating(null); setError(""); } }}
          className="min-w-0 flex-1 bg-transparent text-xs text-vs-fg outline-none placeholder:text-vs-muted" />
        {busy && <SpinnerIcon className="h-3 w-3 text-vs-muted" />}
      </label>
      <p className="mt-1 px-0.5 text-[10.5px] text-vs-muted">Enter to create · Esc to cancel{creating.kind === "folder" ? " · keeps a .gitkeep so Git stores the folder" : ""}</p>
    </form>
  );

  const dialog = upload && (
    <Modal
      title={`Add ${upload.files.length} ${upload.files.length === 1 ? "file" : "files"}`}
      description="They are saved to the repository as one change everyone in the room sees."
      onClose={() => { if (!busy) { setUpload(null); setError(""); } }}
      footer={<>
        <GhostButton disabled={busy} onClick={() => { setUpload(null); setError(""); }}>Cancel</GhostButton>
        <PrimaryButton disabled={busy || !sendable.length || blockedByFolder.length > 0} onClick={() => void submitUpload()}>
          {busy && <SpinnerIcon className="h-4 w-4" />}
          {upload.confirmReplace && conflicts.length ? `Replace ${conflicts.length} and add` : `Add ${sendable.length} ${sendable.length === 1 ? "file" : "files"}`}
        </PrimaryButton>
      </>}
    >
      <label className="block text-xs text-vs-muted">
        Folder
        <input value={upload.folder} disabled={busy} onChange={(event) => setUpload({ ...upload, folder: event.target.value, confirmReplace: false })}
          placeholder="(project root)" aria-label="Destination folder" className={`${inputClass} mt-1`} />
      </label>
      <ul className="vs-scroll max-h-56 space-y-1 overflow-auto" aria-label="Files to add">
        {planned.map(({ file, path, tooBig }) => (
          <li key={path} className="flex items-center gap-2 rounded-lg px-2 py-1.5 text-xs hover:bg-vs-hover">
            <FileIcon className="h-3.5 w-3.5 shrink-0 text-vs-muted" />
            <span className="min-w-0 flex-1 truncate text-vs-fg" title={path}>{path}</span>
            {tooBig ? <span className="shrink-0 text-vs-danger">over 8 MB</span>
              : existing.get(path) === "file" ? <span className="shrink-0 text-vs-warn">replaces existing</span>
              : existing.get(path) === "dir" ? <span className="shrink-0 text-vs-danger">a folder has this name</span>
              : <span className="shrink-0 text-vs-muted">{humanBytes(file.size)}</span>}
          </li>
        ))}
      </ul>
      {upload.confirmReplace && conflicts.length > 0 && (
        <p role="alert" className="rounded-lg border border-vs-warn/40 bg-vs-warn/10 p-2.5 text-xs text-vs-warn">
          {conflicts.length === 1 ? `${conflicts[0]} already exists` : `${conflicts.length} files already exist`}. Select the button again to replace {conflicts.length === 1 ? "it" : "them"}.
        </p>
      )}
      {planned.some((item) => item.tooBig) && <p className="text-xs text-vs-muted">Files over 8 MB are skipped; attach them to a chat message instead.</p>}
      {error && <p role="alert" className="text-xs text-vs-danger">{error}</p>}
    </Modal>
  );

  /** Drop files anywhere on the file list; folders are not uploaded this way. */
  const dropProps = {
    // Handled here, so the workspace's own "drop a project folder" import never sees it.
    onDragOver: (event: React.DragEvent) => { if (event.dataTransfer.types.includes("Files")) { event.preventDefault(); event.stopPropagation(); setDragging(true); } },
    onDragLeave: (event: React.DragEvent) => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDragging(false); },
    onDrop: (event: React.DragEvent) => {
      if (!event.dataTransfer.files.length) return;
      event.preventDefault(); event.stopPropagation(); setDragging(false);
      const items = Array.from(event.dataTransfer.items ?? []);
      const files = Array.from(event.dataTransfer.files).filter((_, index) => !items[index]?.webkitGetAsEntry?.()?.isDirectory);
      if (files.length < event.dataTransfer.files.length) setError("Folders can't be dropped here; use Import project files for a whole folder.");
      openUpload(files);
    },
  };

  return { toolbar, inline, dialog, dropProps, dragging, error: upload ? "" : error };
}

function ToolButton({ label, onClick, children }: { label: string; onClick: () => void; children: React.ReactNode }) {
  return (
    <button type="button" onClick={onClick} aria-label={label} title={label}
      className="inline-flex h-5 items-center rounded px-1 text-vs-muted transition hover:bg-vs-hover hover:text-vs-fg">
      {children}
    </button>
  );
}
