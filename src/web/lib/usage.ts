// Token usage chart math: bars aligned to the viewer's local clock, honest
// granularity (a bucket coarser than a bar is never smeared across it),
// round axis steps and tick placement.

import type {
  ModelPrice,
  UsageBucket,
  UsageModelTotals,
  UsageRange,
} from "../../dashboard-types.js";
import { formatClock } from "./format.js";

export interface RangeSpec {
  bars: number;
  unit: "minute" | "hour" | "day";
  size: number;
  per: string;
  window: string;
}

export const RANGE_SPECS: Record<UsageRange, RangeSpec> = {
  "1h": { bars: 60, unit: "minute", size: 1, per: "minute", window: "last hour" },
  "6h": { bars: 72, unit: "minute", size: 5, per: "5 minutes", window: "last 6 hours" },
  "24h": { bars: 24, unit: "hour", size: 1, per: "hour", window: "last 24 hours" },
  "7d": { bars: 7, unit: "day", size: 1, per: "day", window: "last 7 days" },
  "30d": { bars: 30, unit: "day", size: 1, per: "day", window: "last 30 days" },
};

/** Ranges saved by earlier dashboards, mapped to the closest current range. */
export const LEGACY_RANGES: Record<string, UsageRange> = {
  "2h": "1h",
  "4h": "6h",
  "8h": "6h",
  "12h": "6h",
  "1d": "24h",
  "1m": "30d",
};

export interface ChartBar {
  start: number;
  end: number;
  inputTokens: number;
  outputTokens: number;
  requests: number;
  byModel: Record<string, UsageModelTotals>;
}

/** Empty bars aligned to local clock boundaries, oldest first. */
export function buildBars(range: RangeSpec, now: number): ChartBar[] {
  const bars: ChartBar[] = [];
  const empty = (start: number, end: number): ChartBar => ({
    start,
    end,
    inputTokens: 0,
    outputTokens: 0,
    requests: 0,
    byModel: {},
  });
  const d = new Date(now);
  if (range.unit === "day") {
    for (let i = range.bars - 1; i >= 0; i--) {
      const start = new Date(d.getFullYear(), d.getMonth(), d.getDate() - i).getTime();
      const end = new Date(d.getFullYear(), d.getMonth(), d.getDate() - i + 1).getTime();
      bars.push(empty(start, end));
    }
    return bars;
  }
  const stepMs = range.unit === "hour" ? 3_600_000 : range.size * 60_000;
  d.setSeconds(0, 0);
  if (range.unit === "hour") d.setMinutes(0);
  else d.setMinutes(d.getMinutes() - (d.getMinutes() % range.size));
  for (let j = range.bars - 1; j >= 0; j--) {
    const start = d.getTime() - j * stepMs;
    bars.push(empty(start, start + stepMs));
  }
  return bars;
}

export function aggregateBars(
  buckets: UsageBucket[],
  range: RangeSpec,
  now: number,
): ChartBar[] {
  const bars = buildBars(range, now);
  const barSpan = range.unit === "day" ? 86_400_000 : bars[0].end - bars[0].start;
  const first = bars[0].start;
  const last = bars[bars.length - 1].end;
  for (const bucket of buckets) {
    // Coarser buckets than one bar cannot be placed honestly; skip them.
    if (bucket.span > barSpan) continue;
    const t = bucket.start;
    if (!(t >= first && t < last)) continue;
    let lo = 0;
    let hi = bars.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (bars[mid].start <= t) lo = mid;
      else hi = mid - 1;
    }
    const bar = bars[lo];
    bar.inputTokens += bucket.inputTokens;
    bar.outputTokens += bucket.outputTokens;
    bar.requests += bucket.requests;
    for (const [model, src] of Object.entries(bucket.byModel)) {
      const dst = (bar.byModel[model] ??= { inputTokens: 0, outputTokens: 0, requests: 0 });
      dst.inputTokens += src.inputTokens;
      dst.outputTokens += src.outputTokens;
      dst.requests += src.requests;
    }
  }
  return bars;
}

/** Smallest round step (1, 2, 2.5, 5 × 10^n) covering max in ≤ maxTicks steps. */
export function niceAxis(maxValue: number, maxTicks: number): { max: number; step: number } {
  if (!(maxValue > 0)) return { max: 1, step: 1 };
  const mag = Math.pow(10, Math.floor(Math.log10(maxValue / maxTicks)));
  for (const multiplier of [1, 2, 2.5, 5, 10, 20, 25, 50]) {
    const step = multiplier * mag;
    const ticks = Math.ceil(maxValue / step);
    if (ticks <= maxTicks) return { max: ticks * step, step };
  }
  return { max: maxValue, step: maxValue / maxTicks };
}

export function formatAxisTokens(n: number): string {
  if (n === 0) return "0";
  const units: Array<[number, string]> = [
    [1e9, "B"],
    [1e6, "M"],
    [1e3, "K"],
  ];
  for (const [size, suffix] of units) {
    if (n >= size) return `${Math.round((n / size) * 10) / 10}${suffix}`;
  }
  return String(Math.round(n));
}

function sameLocalDay(a: number, b: number): boolean {
  const x = new Date(a);
  const y = new Date(b);
  return (
    x.getFullYear() === y.getFullYear() &&
    x.getMonth() === y.getMonth() &&
    x.getDate() === y.getDate()
  );
}

/** Preferred ticks fall on round clock times. */
export function isPreferredTick(bar: ChartBar, index: number, range: RangeSpec): boolean {
  const d = new Date(bar.start);
  if (range.unit === "minute" && range.size === 1) return d.getMinutes() % 10 === 0;
  if (range.unit === "minute") return d.getMinutes() === 0;
  if (range.unit === "hour") return d.getHours() % 3 === 0;
  if (range.bars <= 7) return true;
  return (range.bars - 1 - index) % 5 === 0;
}

/** Indices of ticks to label, thinned so labels never collide. */
export function tickIndices(
  bars: ChartBar[],
  range: RangeSpec,
  step: number,
  minGap = 72,
): number[] {
  const keep: number[] = [];
  bars.forEach((bar, i) => {
    if (!isPreferredTick(bar, i, range)) return;
    if (keep.length === 0 || (i - keep[keep.length - 1]) * step >= minGap) keep.push(i);
  });
  return keep;
}

export function tickLabel(bar: ChartBar, range: RangeSpec): string {
  const d = new Date(bar.start);
  if (range.unit === "day")
    return range.bars <= 7
      ? `${d.toLocaleDateString([], { weekday: "short" })} ${d.getDate()}`
      : d.toLocaleDateString([], { month: "short", day: "numeric" });
  if (range.unit === "hour" && d.getHours() === 0)
    return d.toLocaleDateString([], { month: "short", day: "numeric" });
  return formatClock(bar.start);
}

export function barTitle(bar: ChartBar, range: RangeSpec, now: number): string {
  const d = new Date(bar.start);
  if (range.unit === "day")
    return d.toLocaleDateString([], { weekday: "short", month: "short", day: "numeric" });
  let span =
    range.unit === "minute" && range.size === 1
      ? formatClock(bar.start)
      : `${formatClock(bar.start)}–${formatClock(bar.end)}`;
  if (!sameLocalDay(bar.start, now))
    span = `${d.toLocaleDateString([], { weekday: "short", month: "short", day: "numeric" })}, ${span}`;
  return span;
}

export function modelTokenTotals(bars: ChartBar[]): Record<string, number> {
  const totals: Record<string, number> = {};
  for (const bar of bars) {
    for (const [model, t] of Object.entries(bar.byModel)) {
      totals[model] = (totals[model] || 0) + t.inputTokens + t.outputTokens;
    }
  }
  return totals;
}

export interface Savings {
  totalUsd: number;
  byModel: Record<string, number>;
}

/** What the traffic would have cost at paid API list prices. */
export function computeSavings(
  bars: Array<{ byModel: Record<string, UsageModelTotals> }>,
  pricing: Record<string, ModelPrice>,
  models?: Set<string>,
): Savings {
  const byModel: Record<string, number> = {};
  let totalUsd = 0;
  for (const bar of bars) {
    for (const [model, t] of Object.entries(bar.byModel)) {
      if (models && !models.has(model)) continue;
      const price = pricing[model];
      if (!price) continue;
      const usd =
        (t.inputTokens / 1e6) * price.inputPer1M + (t.outputTokens / 1e6) * price.outputPer1M;
      byModel[model] = (byModel[model] || 0) + usd;
      totalUsd += usd;
    }
  }
  return { totalUsd, byModel };
}

export interface RangeSummary {
  inputTokens: number;
  outputTokens: number;
  requests: number;
  peak: { value: number; bar: ChartBar | null };
}

export function summarizeBars(bars: ChartBar[], models: string[]): RangeSummary {
  const summary: RangeSummary = {
    inputTokens: 0,
    outputTokens: 0,
    requests: 0,
    peak: { value: 0, bar: null },
  };
  for (const bar of bars) {
    let barTotal = 0;
    for (const model of models) {
      const t = bar.byModel[model];
      if (!t) continue;
      summary.inputTokens += t.inputTokens;
      summary.outputTokens += t.outputTokens;
      summary.requests += t.requests;
      barTotal += t.inputTokens + t.outputTokens;
    }
    if (barTotal > summary.peak.value) summary.peak = { value: barTotal, bar };
  }
  return summary;
}

export interface HeatmapDay {
  key: string;
  date: number;
}

/** Last `days` local days, oldest first, plus a day|hour → requests map. */
export function buildHeatmap(
  hours: Array<[number, number]>,
  now: number,
  days = 60,
): { days: HeatmapDay[]; cells: Map<string, number>; max: number } {
  const dayList: HeatmapDay[] = [];
  const today = new Date(now);
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(today.getFullYear(), today.getMonth(), today.getDate() - i);
    dayList.push({ key: localDayKey(d.getTime()), date: d.getTime() });
  }
  const cells = new Map<string, number>();
  let max = 0;
  for (const [start, requests] of hours) {
    const d = new Date(start);
    const key = `${localDayKey(start)}|${d.getHours()}`;
    const value = (cells.get(key) || 0) + requests;
    cells.set(key, value);
    if (value > max) max = value;
  }
  return { days: dayList, cells, max };
}

export function localDayKey(ms: number): string {
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
