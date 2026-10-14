import Link from "next/link";
import { categories, guides } from "./content";
import styles from "./docs.module.css";

export default function Documentation() {
  return <div className={styles.overview}>
    <p className={styles.eyebrow}>THE MULTICODE AI HANDBOOK</p>
    <h1>From your first prompt<br />to working together.</h1>
    <p className={styles.lead}>Install the app, connect your tools, and bring your team into the work. Practical guides for every step, with screenshots of the actual interface.</p>
    <div className={styles.startCards}>
      <Link href="/docs/prerequisites"><span>01 · BEFORE YOU START</span><h2>Check the prerequisites</h2><p>See what readers, guests, and people running AI need.</p><b aria-hidden="true">↗</b></Link>
      <Link href="/docs/download-install"><span>02 · GET CONNECTED</span><h2>Download & set up</h2><p>Install desktop, sign in, and connect your computer.</p><b aria-hidden="true">↗</b></Link>
      <Link href="/docs/first-conversation"><span>03 · MAKE SOMETHING</span><h2>Start your first chat</h2><p>Ask a question with or without a repository.</p><b aria-hidden="true">↗</b></Link>
    </div>
    <aside className={styles.callout}><strong>Joining as a guest?</strong><p>You can read and leave permitted comments in your browser. To send AI prompts, you need edit access, a connected computer, Git, and a configured AI tool. <Link href="/docs/sharing">Learn how sharing works →</Link></p></aside>
    <div className={styles.categoryGrid}>{categories.map(category => <section key={category}><h2>{category}</h2>{guides.filter(guide => guide.category === category).map(guide => <Link key={guide.slug} href={`/docs/${guide.slug}`}><span>{guide.title}</span><p>{guide.description}</p></Link>)}</section>)}</div>
    <footer className={styles.footer}>Screenshots use sample accounts and project data. Available providers, models, permissions, and downloads depend on your setup.</footer>
  </div>;
}
