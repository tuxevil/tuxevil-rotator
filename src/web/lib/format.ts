// Pure formatting helpers. No DOM access, so tests can import them directly.

const SECOND = 1000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** Two largest units ("3d 23h", "4h 47m", "12m 5s", "40s"). */
export function formatDuration(ms: number): string {
  if (!(ms > 0)) return "—";
  const s = Math.floor(ms / SECOND);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ${m % 60}m`;
  const d = Math.floor(h / 24);
  return `${d}d ${h % 24}h`;
}

/** Single coarse unit for compact cells ("3d", "4h", "12m", "40s"). */
export function formatDurationCoarse(ms: number): string {
  if (!(ms > 0)) return "—";
  if (ms < MINUTE) return `${Math.floor(ms / SECOND)}s`;
  if (ms < HOUR) return `${Math.floor(ms / MINUTE)}m`;
  if (ms < DAY) return `${Math.floor(ms / HOUR)}h`;
  return `${Math.floor(ms / DAY)}d`;
}

export function formatRelative(ts: number | null | undefined, now: number): string {
  if (!ts) return "never";
  const diff = now - ts;
  if (diff < 5 * SECOND) return "just now";
  if (diff < MINUTE) return `${Math.floor(diff / SECOND)}s ago`;
  if (diff < HOUR) return `${Math.floor(diff / MINUTE)}m ago`;
  if (diff < DAY) return `${Math.floor(diff / HOUR)}h ago`;
  return `${Math.floor(diff / DAY)}d ago`;
}

export function formatCount(n: number | null | undefined): string {
  const value = Number(n) || 0;
  return value.toLocaleString("en-US");
}

/** 1.2K / 3.4M / 1.25B with one decimal; integers below 1000. */
export function formatCompact(n: number | null | undefined): string {
  const value = Number(n) || 0;
  const abs = Math.abs(value);
  if (abs >= 1e9) return `${trim(value / 1e9, 2)}B`;
  if (abs >= 1e6) return `${trim(value / 1e6, 1)}M`;
  if (abs >= 1e3) return `${trim(value / 1e3, 1)}K`;
  return String(Math.round(value));
}

function trim(value: number, digits: number): string {
  return String(Number(value.toFixed(digits)));
}

export function formatMs(ms: number | null | undefined): string {
  const value = Number(ms);
  if (!Number.isFinite(value) || value < 0) return "—";
  if (value >= MINUTE) return `${(value / MINUTE).toFixed(1)}m`;
  if (value >= SECOND) return `${(value / SECOND).toFixed(1)}s`;
  return `${Math.round(value)}ms`;
}

/** Dollar amounts that stay readable from $0.000002 up to $12,345.67. */
export function formatUsd(usd: number | null | undefined): string {
  const value = Number(usd) || 0;
  if (value <= 0) return "$0";
  if (value >= 1000)
    return `$${value.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  if (value >= 0.01) return `$${value.toFixed(2)}`;
  if (value >= 0.0001) return `$${value.toFixed(4)}`;
  return `$${value.toFixed(6)}`;
}

export function formatPercent(fraction: number | null | undefined): string {
  const value = Number(fraction);
  if (!Number.isFinite(value)) return "—";
  return `${Math.round(value * 100)}%`;
}

export function formatClock(ms: number): string {
  return new Date(ms).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

export function formatClockSeconds(ms: number): string {
  return new Date(ms).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

export function formatDateTime(ms: number): string {
  return new Date(ms).toLocaleString([], {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export function pluralize(count: number, singular: string, plural = `${singular}s`): string {
  return `${count} ${count === 1 ? singular : plural}`;
}

export function joinNatural(items: string[]): string {
  if (items.length <= 1) return items.join("");
  if (items.length === 2) return `${items[0]} and ${items[1]}`;
  return `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
}
