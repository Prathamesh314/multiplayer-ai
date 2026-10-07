import Link from "next/link";
import styles from "./docs.module.css";
export default function DocsNotFound() { return <div className={styles.overview}><p className={styles.eyebrow}>DOCUMENTATION</p><h1>That guide wasn’t found.</h1><p className={styles.lead}>Browse the handbook or search for the feature you need.</p><Link href="/docs">Back to documentation →</Link></div>; }
