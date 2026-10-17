import { LogoMark } from "../LogoMark";
import styles from "./marketing.module.css";
export function Brand() {
  return <span className={styles.brand}><LogoMark className={styles.brandMark} />multicode<span className={styles.brandAi}>ai</span></span>;
}
