import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { AppScreenshot } from "../../components/marketing/AppScreenshot";
import { CodeBlock } from "../../components/docs/CodeBlock";
import { findGuide, guides } from "../content";
import { screenshots } from "../screenshots";
import styles from "../docs.module.css";

export const dynamicParams = false;
export function generateStaticParams() { return guides.map(({ slug }) => ({ slug })); }
export async function generateMetadata({ params }: { params: Promise<{ slug: string }> }): Promise<Metadata> {
  const guide = findGuide((await params).slug);
  return guide ? { title: guide.title, description: guide.description } : {};
}

export default async function GuidePage({ params }: { params: Promise<{ slug: string }> }) {
  const guide = findGuide((await params).slug);
  if (!guide) notFound();
  const position = guides.indexOf(guide), previous = guides[position - 1], next = guides[position + 1];
  return <div className={styles.articleLayout}>
    <article className={styles.article}>
      <nav className={styles.breadcrumb} aria-label="Breadcrumb"><Link href="/docs">Docs</Link><span aria-hidden="true">/</span><span>{guide.category}</span></nav>
      <h1>{guide.title}</h1><p className={styles.lead}>{guide.description}</p>
      <details className={styles.mobileToc}><summary>On this page</summary><ul>{guide.sections.map(section => <li key={section.id}><a href={`#${section.id}`}>{section.title}</a></li>)}</ul></details>
      {guide.sections.map(section => <section id={section.id} key={section.id} className={styles.section}>
        <h2><a href={`#${section.id}`}>{section.title}<span aria-hidden="true"> #</span></a></h2>
        <div className={styles.prose}><ReactMarkdown remarkPlugins={[remarkGfm]} components={{
          a: ({ href, children }) => href?.startsWith("/") ? <Link href={href}>{children}</Link> : <a href={href} rel="noreferrer">{children}</a>,
          pre: ({ children }) => <CodeBlock>{children}</CodeBlock>,
          table: ({ children }) => <div className={styles.tableScroll} tabIndex={0} role="region" aria-label={`${section.title} comparison table`}><table>{children}</table></div>,
        }}>{section.body}</ReactMarkdown></div>
        {section.screenshot && screenshots[section.screenshot] && <figure className={styles.figure}>
          <AppScreenshot {...screenshots[section.screenshot]} />
          <figcaption>{screenshots[section.screenshot].label} · Actual interface with sample data. Select the image to enlarge.</figcaption>
        </figure>}
      </section>)}
      <nav className={styles.pagination} aria-label="Previous and next guides">{previous ? <Link href={`/docs/${previous.slug}`}><span>← Previous guide</span>{previous.title}</Link> : <span />}{next && <Link href={`/docs/${next.slug}`}><span>Next guide →</span>{next.title}</Link>}</nav>
      <footer className={styles.footer}><Link href="/docs/troubleshooting">Something not working? Read troubleshooting →</Link></footer>
    </article>
    <aside className={styles.toc}><nav aria-label="On this page"><p>On this page</p>{guide.sections.map(section => <a key={section.id} href={`#${section.id}`}>{section.title}</a>)}</nav></aside>
  </div>;
}
