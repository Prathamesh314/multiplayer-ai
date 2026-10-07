"use client";

import { Modal } from "../ui/Modal";

export type RoomGuideAction = "files" | "chat" | "team" | "invite" | "providers" | "devices";

export function RoomGuide({ hasRepo, readOnly, onClose, onAction }: {
  hasRepo: boolean;
  readOnly: boolean;
  onClose: () => void;
  onAction: (action: RoomGuideAction) => void;
}) {
  const steps: { title: string; body: string; label: string; action: RoomGuideAction; disabled?: boolean }[] = [
    { title: "Choose your starting point", body: "Start without files for conversation, or import a folder to work with code. Files are optional, and your chats are saved either way.", label: hasRepo ? "Browse files" : "Add a repository or start without files", action: "files", disabled: !hasRepo && readOnly },
    { title: "Choose your AI", body: "Connect a provider and choose a model in the message box. To use your own computer, pair it and keep its runner running.", label: "Set up AI", action: "providers" },
    { title: "Give it a task", body: "Choose a starter or write your own request, then press Send. Use @ to reference an available team chat. Starter buttons never run AI.", label: "Open AI chat", action: "chat", disabled: !hasRepo },
    { title: "Continue as a team", body: "Open a chat from Chats & team. Hand off transfers control to a teammate; Copy chat starts a separate conversation instead.", label: "Browse team chats", action: "team", disabled: !hasRepo },
  ];
  return <Modal title="Room guide" description="Your code, your AI, and your teammates in one place. Start small, review the result, then pass the work on." onClose={onClose} width="max-w-2xl">
    {readOnly && <p className="rounded-lg border border-vs-border p-3 text-sm text-vs-muted">You have view-only access. You can explore files and chats; ask a project manager for edit access to make changes or run AI.</p>}
    <ol className="grid gap-3 sm:grid-cols-2">
      {steps.map((step, index) => <li key={step.action} className="flex flex-col rounded-xl border border-vs-border bg-vs-editor p-4">
        <span className="mb-3 flex h-7 w-7 items-center justify-center rounded-lg bg-vs-accent/10 text-xs font-semibold text-vs-accent">{index + 1}</span>
        <h3 className="font-semibold">{step.title}</h3>
        <p className="mb-4 mt-2 text-sm leading-6 text-vs-muted">{step.body}</p>
        <button type="button" disabled={step.disabled} onClick={() => onAction(step.action)} className="mt-auto self-start rounded-lg border border-vs-border px-3 py-2 text-sm font-medium hover:bg-vs-hover disabled:opacity-50">{step.label}</button>
      </li>)}
    </ol>
    <div className="rounded-xl border border-vs-accent/20 bg-vs-accent/5 p-4 text-sm leading-6">
      <h3 className="font-semibold">Review before sharing changes</h3>
      <p className="mt-1 text-vs-muted">Inspect edits in Changes. Publish sends saved work to the shared project, not a GitHub pull request. Get latest brings project updates into your room. Imported folders stay separate.</p>
    </div>
    <div className="flex flex-wrap gap-2">
      <button type="button" onClick={() => onAction("invite")} className="rounded-lg bg-vs-accent px-3 py-2 text-sm font-medium text-vs-accent-fg">Invite a teammate</button>
      <button type="button" onClick={() => onAction("devices")} className="rounded-lg border border-vs-border px-3 py-2 text-sm hover:bg-vs-hover">Connect your computer</button>
    </div>
    <p className="text-xs leading-5 text-vs-muted">Imported files are uploaded to this room. Authorized teammates can access its shared content, and your chosen AI provider may receive task context. Local execution does not necessarily mean an offline model.</p>
  </Modal>;
}
