import type { Metadata } from "next";
import Link from "next/link";
import { DocsNavigation } from "../components/docs/DocsNavigation";
import { Brand } from "../components/marketing/Brand";
import { DISCORD_INVITE } from "../components/marketing/Community";
import { categories, guides } from "./content";
import styles from "./docs.module.css";

export const metadata: Metadata = { title: { default: "Documentation | Multicode AI", template: "%s | Multicode AI Docs" }, description: "Download, set up, and use Multicode AI. Step-by-step guides to prerequisites, AI tools, projects, guest sharing, and team collaboration." };

export default function DocsLayout({ children }: { children: React.ReactNode }) {
  const index = guides.map(({ slug, title, description, category, sections }) => ({ slug, title, description, category, sections: sections.map(({ id, title, body }) => ({ id, title, text: body })) }));
  return <div className={styles.site} data-docs-scroll>
    <a href="#docs-content" className={styles.skip}>Skip to documentation</a>
    <header className={styles.header}>
      <Link className={styles.brand} href="/" aria-label="Multicode AI home"><Brand /></Link>
      <Link href="/docs" className={styles.docsLabel}>Docs</Link>
      <nav aria-label="Website navigation"><a href={DISCORD_INVITE} target="_blank" rel="noreferrer">Discord</a><Link href="/#download">Download</Link><Link href="/workspace" className={styles.workspaceLink}>Open workspace <span aria-hidden="true">↗</span></Link></nav>
    </header>
    <div className={styles.layout}>
      <DocsNavigation guides={index} categories={categories} />
      <main id="docs-content" className={styles.main} tabIndex={-1}>{children}</main>
    </div>
  </div>;
}
