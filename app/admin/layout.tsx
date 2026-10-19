import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Admin · Multicode AI",
  robots: { index: false, follow: false },
};

export default function AdminLayout({ children }: { children: React.ReactNode }) {
  return <div className="min-h-dvh bg-vs-editor text-vs-fg">{children}</div>;
}
