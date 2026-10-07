import Link from "next/link";

/** The same execution promise before signup, before creating a chat, and at setup. */
export function ExecutionRequirements({guest=false,className=""}:{guest?:boolean;className?:string}) {
  return <aside aria-label="What you need to get started" className={`rounded-xl border border-vs-border bg-vs-panel p-3 text-left text-sm leading-6 ${className}`}>
    <p className="font-medium text-vs-fg">{guest?'Joining a shared conversation':'Before you start'}</p>
    <p className="mt-1 text-vs-muted">Guests can read and comment in the browser without connecting a computer.</p>
    <p className="mt-1 text-vs-muted">Sending AI prompts—even without files—requires the desktop app, Git, and a signed-in AI tool on a computer that stays online.</p>
    <details className="mt-2 text-vs-muted"><summary className="cursor-pointer text-vs-accent">AI setup and usage</summary><p className="mt-2">Use a supported AI command-line tool with your own provider account. Its usage limits apply. Reading and commenting needs no AI subscription.</p><Link href="/docs/prerequisites" className="mt-2 inline-block text-vs-accent underline underline-offset-4">Desktop app and setup requirements</Link></details>
  </aside>;
}
