import styles from "./marketing.module.css";
export function Brand() {
  return <span className={styles.brand}><span className={styles.brandMark} aria-hidden="true"><i /><i /><i /></span>multicode<span className={styles.brandAi}>ai</span></span>;
}
