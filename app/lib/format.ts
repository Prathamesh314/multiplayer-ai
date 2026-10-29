const UNITS = ["B", "KB", "MB", "GB", "TB"];

export function humanBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  const exponent = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), UNITS.length - 1);
  const value = bytes / 1024 ** exponent;
  return `${value >= 100 || exponent === 0 ? Math.round(value) : value.toFixed(1)} ${UNITS[exponent]}`;
}

export function humanCount(count: number): string {
  return count.toLocaleString("en-US");
}

const DIVISIONS: [number, Intl.RelativeTimeFormatUnit][] = [
  [60, "second"],
  [60, "minute"],
  [24, "hour"],
  [7, "day"],
  [4.34524, "week"],
  [12, "month"],
  [Infinity, "year"],
];

/** Past this, a timestamp in seconds is really milliseconds (it would be after the year 5138). */
const MILLISECONDS_FROM = 1e11;

/**
 * "5 minutes ago" for a moment in seconds since the epoch. Never an impossible
 * time: a millisecond value is read as one, a missing or invalid one gives "",
 * and a moment slightly ahead of this clock (another computer's) is "now".
 */
export function relativeTime(unixSeconds: number | null | undefined): string {
  if (typeof unixSeconds !== "number" || !Number.isFinite(unixSeconds) || unixSeconds <= 0) return "";
  const seconds = unixSeconds >= MILLISECONDS_FROM ? unixSeconds / 1000 : unixSeconds;
  const formatter = new Intl.RelativeTimeFormat("en", { numeric: "auto" });
  let duration = Math.min(seconds - Date.now() / 1000, 0);

  for (const [amount, unit] of DIVISIONS) {
    if (Math.abs(duration) < amount) return formatter.format(Math.round(duration), unit);
    duration /= amount;
  }
  return "";
}
