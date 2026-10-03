// Hand-rolled SVG charts: a traffic sparkline, the stacked token chart and
// the activity heatmap. No chart library; everything follows the theme.

import { Fragment, type JSX } from "preact";
import { useLayoutEffect, useRef, useState } from "preact/hooks";
import { formatClock, formatCompact, formatCount } from "../lib/format.js";
import { modelColor } from "../lib/colors.js";
import {
  barTitle,
  formatAxisTokens,
  niceAxis,
  tickIndices,
  tickLabel,
  type ChartBar,
  type RangeSpec,
} from "../lib/usage.js";

function useWidth<T extends HTMLElement>(fallback: number): [{ current: T | null }, number] {
  const ref = useRef<T>(null);
  const [width, setWidth] = useState(fallback);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    setWidth(Math.floor(el.clientWidth) || fallback);
    if (typeof ResizeObserver !== "function") return;
    const observer = new ResizeObserver((entries) => {
      const next = Math.floor(entries[0].contentRect.width);
      if (next > 0) setWidth(next);
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);
  return [ref, width];
}

/**
 * Minute-level trend with a hover cursor; the last point carries an end
 * marker. With `onHover` the caller shows the readout (in a header, say)
 * instead of the floating tip.
 */
export function Sparkline({
  values,
  times,
  unit,
  label,
  height = 44,
  onHover,
}: {
  values: number[];
  /** Start of each point, for the hover readout. */
  times?: number[];
  unit: string;
  label: string;
  height?: number;
  onHover?: (index: number | null) => void;
}): JSX.Element {
  const [hover, setHoverState] = useState<number | null>(null);
  const setHover = (index: number | null) => {
    if (index === hover) return;
    setHoverState(index);
    onHover?.(index);
  };
  const max = Math.max(1, ...values);
  const step = values.length > 1 ? 100 / (values.length - 1) : 100;
  const yOf = (v: number) => height - 3 - (v / max) * (height - 8);
  const points = values.map((v, i) => [i * step, yOf(v)] as const);
  const line = points.map(([x, y], i) => `${i === 0 ? "M" : "L"}${x.toFixed(2)},${y.toFixed(2)}`).join(" ");
  const area = `${line} L100,${height} L0,${height} Z`;
  const marked = hover ?? (values.length > 0 ? values.length - 1 : null);
  const markX = marked === null ? 0 : marked * step;
  const markY = marked === null ? 0 : (yOf(values[marked]) / height) * 100;
  return (
    <div
      class={`sparkline-wrap${hover !== null ? " is-hover" : ""}`}
      onPointerMove={(event) => {
        if (values.length === 0) return;
        const rect = (event.currentTarget as HTMLElement).getBoundingClientRect();
        const ratio = Math.min(1, Math.max(0, (event.clientX - rect.left) / rect.width));
        setHover(Math.round(ratio * (values.length - 1)));
      }}
      onPointerLeave={() => setHover(null)}
    >
      <svg class="sparkline" viewBox={`0 0 100 ${height}`} preserveAspectRatio="none" role="img" aria-label={label}>
        <path class="sparkline-area" d={area} />
        <path class="sparkline-line" d={line} vector-effect="non-scaling-stroke" />
      </svg>
      {marked !== null && (
        <>
          {hover !== null && <span class="sparkline-cursor" style={{ left: `${markX}%` }} />}
          <span class="sparkline-dot" style={{ left: `${markX}%`, top: `${markY}%` }} />
        </>
      )}
      {hover !== null && !onHover && (
        <span class={`sparkline-tip${markX > 55 ? " is-left" : ""}`} style={{ left: `${markX}%` }} role="tooltip">
          <strong class="num">{formatCount(values[hover])}</strong> {unit}
          {times?.[hover] !== undefined && <span class="sparkline-tip-time"> · {formatClock(times[hover])}</span>}
        </span>
      )}
    </div>
  );
}

/** A bar's top segment: 4px rounded data-end, square at the baseline. */
function roundedTop(x: number, y: number, w: number, h: number, r: number): string {
  const radius = Math.max(0, Math.min(r, w / 2, h));
  return `M${x},${y + h}V${y + radius}A${radius},${radius} 0 0 1 ${x + radius},${y}H${x + w - radius}A${radius},${radius} 0 0 1 ${x + w},${y + radius}V${y + h}Z`;
}

function stackSegments(bar: ChartBar, models: string[], axisMax: number, plotHeight: number): Array<{ model: string; h: number }> {
  const out: Array<{ model: string; h: number }> = [];
  for (const model of models) {
    const t = bar.byModel[model];
    if (!t) continue;
    const h = ((t.inputTokens + t.outputTokens) / axisMax) * plotHeight;
    if (h > 0) out.push({ model, h });
  }
  return out;
}

export function TokenChart({
  bars,
  models,
  range,
  now,
  highlight,
  ariaLabel,
}: {
  bars: ChartBar[];
  /** Visible models, largest first (bottom of each stack). */
  models: string[];
  range: RangeSpec;
  now: number;
  highlight: string | null;
  ariaLabel: string;
}): JSX.Element {
  const [wrapRef, width] = useWidth<HTMLDivElement>(800);
  const [hover, setHover] = useState<number | null>(null);
  const tipRef = useRef<HTMLDivElement>(null);
  const [tipLeft, setTipLeft] = useState(0);

  const totals = bars.map((bar) =>
    models.reduce((sum, m) => {
      const t = bar.byModel[m];
      return sum + (t ? t.inputTokens + t.outputTokens : 0);
    }, 0),
  );
  const axis = niceAxis(Math.max(0, ...totals), 5);
  const left = 46;
  const right = 8;
  const top = 10;
  const plotHeight = 180;
  const bottom = top + plotHeight;
  const height = bottom + 26;
  const svgWidth = Math.max(width, bars.length * 8 + left + right);
  const step = (svgWidth - left - right) / Math.max(1, bars.length);
  const barWidth = Math.max(2, Math.min(24, step * 0.66));
  const ticks = tickIndices(bars, range, step);

  const gridLines: JSX.Element[] = [];
  for (let v = 0; v <= axis.max + axis.step / 2; v += axis.step) {
    const y = bottom - (v / axis.max) * plotHeight;
    gridLines.push(
      <g key={v}>
        <line x1={left} x2={svgWidth - right} y1={y} y2={y} class={v === 0 ? "chart-baseline" : "chart-grid"} />
        <text x={left - 8} y={y + 3} text-anchor="end" class="chart-axis">
          {formatAxisTokens(v)}
        </text>
      </g>,
    );
  }

  useLayoutEffect(() => {
    if (hover === null || !tipRef.current || !wrapRef.current) return;
    const scroller = wrapRef.current;
    const cx = left + hover * step + step / 2 - scroller.scrollLeft;
    const tipWidth = tipRef.current.offsetWidth;
    const maxLeft = scroller.clientWidth - tipWidth - 4;
    let next = cx + 14;
    if (next > maxLeft) next = cx - tipWidth - 14;
    setTipLeft(Math.max(4, next));
  }, [hover, step]);

  const hovered = hover !== null ? bars[hover] : null;
  const hoverRows = hovered
    ? models
        .filter((m) => hovered.byModel[m])
        .sort((a, b) => {
          const x = hovered.byModel[a];
          const y = hovered.byModel[b];
          return y.inputTokens + y.outputTokens - (x.inputTokens + x.outputTokens);
        })
    : [];

  return (
    <div class="chart-wrap">
      <div
        class="chart-scroll"
        ref={wrapRef}
        onPointerLeave={() => setHover(null)}
        onPointerMove={(event) => {
          const target = (event.target as Element).closest?.("[data-i]");
          setHover(target ? Number(target.getAttribute("data-i")) : null);
        }}
      >
        <svg class="chart" width={svgWidth} height={height} role="img" aria-label={ariaLabel}>
          {gridLines}
          {bars.map((bar, i) => {
            let y = bottom;
            const x = left + i * step + (step - barWidth) / 2;
            return (
              <g key={bar.start} class={`chart-col${bar.end > now ? " is-live" : ""}${hover === i ? " is-hover" : ""}`} data-i={i}>
                <rect class="chart-hit" x={left + i * step} y={top} width={step} height={plotHeight} />
                {stackSegments(bar, models, axis.max, plotHeight).map((seg, k, all) => {
                  const isTop = k === all.length - 1;
                  // A 2px surface gap separates stacked segments.
                  const gap = !isTop && seg.h > 4 ? 2 : 0;
                  y -= seg.h;
                  const drawY = y + gap;
                  const drawH = Math.max(0.5, seg.h - gap);
                  const cls = `chart-seg${highlight && highlight !== seg.model ? " is-dim" : ""}`;
                  return isTop ? (
                    <path key={seg.model} class={cls} d={roundedTop(x, drawY, barWidth, drawH, 4)} fill={modelColor(seg.model)} />
                  ) : (
                    <rect key={seg.model} class={cls} x={x} y={drawY} width={barWidth} height={drawH} fill={modelColor(seg.model)} />
                  );
                })}
              </g>
            );
          })}
          {ticks.map((i) => {
            const cx = left + i * step + step / 2;
            const anchor = cx > svgWidth - right - 34 ? "end" : cx < left + 34 ? "start" : "middle";
            const tx = anchor === "end" ? Math.min(cx + step / 2, svgWidth - right) : anchor === "start" ? cx - step / 2 : cx;
            return (
              <g key={`t${i}`}>
                <line x1={cx} x2={cx} y1={bottom} y2={bottom + 4} class="chart-tick" />
                <text x={tx} y={bottom + 17} text-anchor={anchor} class="chart-axis">
                  {tickLabel(bars[i], range)}
                </text>
              </g>
            );
          })}
        </svg>
      </div>
      {hovered && (
        <div class="chart-tip" ref={tipRef} style={{ left: `${tipLeft}px`, top: `${top}px` }} role="tooltip">
          <div class="chart-tip-head">
            <strong>{barTitle(hovered, range, now)}</strong>
            {hovered.end > now && <span class="chart-tip-live">in progress</span>}
          </div>
          {hoverRows.length === 0 ? (
            <div class="chart-tip-empty">No requests</div>
          ) : (
            <>
              {hoverRows.map((m) => {
                const t = hovered.byModel[m];
                return (
                  <div class="chart-tip-row" key={m}>
                    <span class="swatch" style={{ background: modelColor(m) }} />
                    <span class="chart-tip-model">{m}</span>
                    <span class="num">{formatCompact(t.inputTokens + t.outputTokens)}</span>
                    <span class="chart-tip-sub num">{formatCount(t.requests)} req</span>
                  </div>
                );
              })}
              <div class="chart-tip-row chart-tip-total">
                <span />
                <span class="chart-tip-model">Total</span>
                <span class="num">
                  {formatCompact(hoverRows.reduce((s, m) => s + hovered.byModel[m].inputTokens + hovered.byModel[m].outputTokens, 0))}
                </span>
                <span class="chart-tip-sub num">
                  {formatCount(hoverRows.reduce((s, m) => s + hovered.byModel[m].requests, 0))} req
                </span>
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}

export function Heatmap({
  days,
  cells,
  max,
}: {
  days: Array<{ key: string; date: number }>;
  cells: Map<string, number>;
  max: number;
}): JSX.Element {
  const level = (v: number): number => {
    if (v <= 0 || max <= 0) return 0;
    const t = v / max;
    if (t < 0.15) return 1;
    if (t < 0.35) return 2;
    if (t < 0.6) return 3;
    return 4;
  };
  const hours = Array.from({ length: 24 }, (_, h) => h);
  return (
    <div class="heatmap-scroll">
      <div class="heatmap" style={{ gridTemplateColumns: `2.25rem repeat(${days.length}, minmax(0.6rem, 1fr))` }} role="img" aria-label="Requests per hour over the last 60 days">
        <span />
        {days.map((day, i) => (
          <span key={day.key} class="heatmap-col-label">
            {i % 7 === 0 ? new Date(day.date).toLocaleDateString([], { month: "short", day: "numeric" }) : ""}
          </span>
        ))}
        {hours.map((hour) => (
          <Fragment key={hour}>
            <span class="heatmap-row-label">
              {hour % 3 === 0 ? `${String(hour).padStart(2, "0")}:00` : ""}
            </span>
            {days.map((day) => {
              const value = cells.get(`${day.key}|${hour}`) || 0;
              return (
                <span
                  key={`${day.key}|${hour}`}
                  class={`heatmap-cell level-${level(value)}`}
                  title={`${new Date(day.date).toLocaleDateString([], { weekday: "short", month: "short", day: "numeric" })} ${String(hour).padStart(2, "0")}:00 · ${formatCount(value)} requests`}
                />
              );
            })}
          </Fragment>
        ))}
      </div>
      <div class="heatmap-legend" aria-hidden="true">
        <span>Less</span>
        {[0, 1, 2, 3, 4].map((l) => (
          <span key={l} class={`heatmap-cell level-${l}`} />
        ))}
        <span>More</span>
      </div>
    </div>
  );
}
