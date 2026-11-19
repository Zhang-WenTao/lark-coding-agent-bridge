// Clock and date strings the bot shows people. All in the process's local
// time zone (the host's), which is what the owner reads them in; dates in a
// configured zone (`dream/schedule.ts`, `dream/recall.ts`) are a different
// thing and stay where they are.

const pad = (n: number): string => String(n).padStart(2, '0');

/** `MM-DD HH:mm`. */
export function formatMonthDayTime(ms: number): string {
  const d = new Date(ms);
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** `YYYY-MM-DD HH:mm`. */
export function formatDateTime(ms: number): string {
  const d = new Date(ms);
  return `${formatLocalDate(ms)} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** `YYYY-MM-DD`: also the day key of per-day tallies. */
export function formatLocalDate(ms: number): string {
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** `HH:mm`. */
export function formatHourMinute(ms: number): string {
  const d = new Date(ms);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** How long ago, in one compact unit for tables: `42s 前`, `5m 前`, `3h 前`, `2d 前`. */
export function formatAgoCompact(ms: number): string {
  if (ms < 60_000) return `${Math.floor(ms / 1000)}s 前`;
  if (ms < 3_600_000) return `${Math.floor(ms / 60_000)}m 前`;
  if (ms < 86_400_000) return `${Math.floor(ms / 3_600_000)}h 前`;
  return `${Math.floor(ms / 86_400_000)}d 前`;
}
