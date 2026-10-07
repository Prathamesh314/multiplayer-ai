"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import styles from "../../docs/docs.module.css";

export type SearchGuide = { slug: string; title: string; description: string; category: string; sections: { id: string; title: string; text: string }[] };

export function DocsNavigation({ guides, categories }: { guides: SearchGuide[]; categories: string[] }) {
  const pathname = usePathname();
  const [query, setQuery] = useState("");
  const menu = useRef<HTMLDetailsElement>(null);
  useEffect(() => {
    const media = matchMedia("(max-width: 800px)");
    const resize = () => { if (menu.current) menu.current.open = !media.matches; };
    resize(); media.addEventListener("change", resize);
    return () => media.removeEventListener("change", resize);
  }, []);
  useEffect(() => {
    if (!location.hash) document.querySelector("[data-docs-scroll]")?.scrollTo({ top: 0 });
  }, [pathname]);
  const terms = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  const results = terms.length ? guides.flatMap<{ guide: SearchGuide; section: SearchGuide["sections"][number] | null; score: number }>(guide => {
    const heading = `${guide.title} ${guide.description}`.toLowerCase();
    if (terms.every(term => heading.includes(term))) return [{ guide, section: null, score: 2 }];
    const section = guide.sections.find(section => terms.every(term => `${guide.title} ${section.title} ${section.text}`.toLowerCase().includes(term)));
    return section ? [{ guide, section, score: 1 }] : [];
  }).sort((a, b) => b.score - a.score) : [];

  return <details ref={menu} open className={styles.navigation}>
    <summary>Browse documentation <span aria-hidden="true">+</span></summary>
    <div className={styles.navigationBody}>
      <div className={styles.search}>
        <label htmlFor="docs-search">Search docs</label>
        <div><input id="docs-search" type="search" placeholder="Find a feature or answer…" value={query} onChange={e => setQuery(e.target.value)} />{query && <button type="button" aria-label="Clear search" onClick={() => setQuery("")}>×</button>}</div>
      </div>
      <nav aria-label={terms.length ? "Documentation search results" : "Documentation"} onClick={e => {
        if ((e.target as HTMLElement).closest("a") && matchMedia("(max-width: 800px)").matches && menu.current) menu.current.open = false;
      }}>
        {terms.length ? <>
          <p role="status" className={styles.resultCount}>{results.length} guide{results.length === 1 ? "" : "s"} found</p>
          {results.map(({ guide, section }) => <Link key={guide.slug} href={`/docs/${guide.slug}${section ? `#${section.id}` : ""}`} className={styles.searchResult} onClick={() => setQuery("")}><strong>{guide.title}</strong><span>{section?.title ?? guide.description}</span></Link>)}
          {!results.length && <p className={styles.noResults}>Try “computer”, “invitation”, “model”, or “review”.</p>}
        </> : <>
          <Link href="/docs" aria-current={pathname === "/docs" ? "page" : undefined}>Documentation home</Link>
          {categories.map(category => <div className={styles.navGroup} key={category}><p>{category}</p>{guides.filter(guide => guide.category === category).map(guide => <Link key={guide.slug} href={`/docs/${guide.slug}`} aria-current={pathname === `/docs/${guide.slug}` ? "page" : undefined}>{guide.title}</Link>)}</div>)}
        </>}
      </nav>
      <Link className={styles.navHelp} href="/docs/troubleshooting">Need a hand? Troubleshooting ↗</Link>
    </div>
  </details>;
}
