"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { usePref } from "@/lib/prefs";
import type { IChartApi, ISeriesApi, Logical, MouseEventParams, Time } from "lightweight-charts";
import type { Bar } from "@/lib/api";

type P = { t: number; p: number };
type Kind = "trend" | "ray" | "hline" | "vline" | "rect" | "fib" | "text" | "measure";
type Tool = "cursor" | Kind;
type Drawing = { id: string; kind: Kind; a: P; b?: P; text?: string; color: string };

const KEY = "goldlab-drawings";
const FIB = [0, 0.236, 0.382, 0.5, 0.618, 0.786, 1];
const COLORS = ["accent", "#7fb0e6", "#26b89a", "#ef5a55", "#c084fc", "#eef0f3"];

const TOOLS: { key: Tool; label: string; d: string; two: boolean }[] = [
  { key: "cursor", label: "Pointer: pan, zoom and select", d: "M5 3l13 8-6 1.5L9 19 5 3Z", two: false },
  { key: "trend", label: "Trend line", d: "M4 19 20 5M4 19h0M20 5h0", two: true },
  { key: "ray", label: "Ray (extends to the right)", d: "M4 18 21 6M4 18h0", two: true },
  { key: "hline", label: "Horizontal line: a price level", d: "M3 12h18M7 12h0", two: false },
  { key: "vline", label: "Vertical line: a moment in time", d: "M12 3v18", two: false },
  { key: "rect", label: "Rectangle: a zone", d: "M4 6h16v12H4z", two: true },
  { key: "fib", label: "Fibonacci retracement", d: "M3 5h18M3 9.5h18M3 13h18M3 19h18", two: true },
  { key: "text", label: "Text note", d: "M5 6V4h14v2M12 4v16M9 20h6", two: false },
  { key: "measure", label: "Measure: price change, % and bars", d: "M4 20 20 4M4 20v-5M4 20h5M20 4h-5M20 4v5", two: true },
];

const NONE: Drawing[] = [];

function distToSeg(px: number, py: number, x1: number, y1: number, x2: number, y2: number) {
  const dx = x2 - x1, dy = y2 - y1, l = dx * dx + dy * dy;
  const k = l ? Math.max(0, Math.min(1, ((px - x1) * dx + (py - y1) * dy) / l)) : 0;
  return Math.hypot(px - (x1 + k * dx), py - (y1 + k * dy));
}

/** Drawing tools over a lightweight-charts chart. Drawings are kept in time and price, so they stay put
 *  as you pan, zoom or change timeframe, and are saved with the account when signed in. */
export default function Drawings({ chart, series, bars, accent }: {
  chart: IChartApi | null; series: ISeriesApi<"Candlestick"> | null; bars: React.RefObject<Bar[]>; accent: string;
}) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const [tool, setTool] = useState<Tool>("cursor");
  const [items, setItems] = useState<Drawing[]>([]);
  const [draft, setDraft] = useState<Drawing | null>(null);
  const [sel, setSel] = useState<string | null>(null);
  const [color, setColor] = useState("accent");
  const [magnet, setMagnet] = useState(true);
  const [hidden, setHidden] = useState(false);
  const [note, setNote] = useState<{ x: number; y: number; at: P; text: string } | null>(null);
  const [confirmClear, setConfirmClear] = useState(false);
  // On phones the toolbar starts folded into one pencil button so the candles stay visible.
  const [open, setOpen] = useState(true);
  useEffect(() => { if (window.innerWidth < 640) setOpen(false); }, []);
  const state = useRef({ items, draft, sel, hidden, accent });
  state.current = { items, draft, sel, hidden, accent };

  // Saved in this browser and, when signed in, in the account so drawings follow the user to other devices.
  const [saved, setSaved] = usePref<Drawing[]>("drawings", KEY, NONE);
  useEffect(() => setItems(saved), [saved]);
  const commit = useCallback((next: Drawing[]) => { setItems(next); setSaved(next.filter((d) => d.kind !== "measure")); }, [setSaved]);

  // Time <-> x through the bar index, so points between bars and beyond the last one still place correctly.
  const xOf = useCallback((t: number): number | null => {
    const bs = bars.current, ts = chart?.timeScale();
    if (!ts || !bs?.length) return null;
    let lo = 0, hi = bs.length - 1;
    const step = bs.length > 1 ? bs[bs.length - 1].t - bs[bs.length - 2].t : 60;
    let logical: number;
    if (t >= bs[hi].t) logical = hi + (t - bs[hi].t) / step;
    else if (t <= bs[0].t) logical = (t - bs[0].t) / (bs.length > 1 ? bs[1].t - bs[0].t : step);
    else {
      while (hi - lo > 1) { const m = (lo + hi) >> 1; if (bs[m].t <= t) lo = m; else hi = m; }
      logical = lo + (t - bs[lo].t) / (bs[hi].t - bs[lo].t);
    }
    return ts.logicalToCoordinate(logical as Logical);
  }, [chart, bars]);

  const tOf = useCallback((x: number): number | null => {
    const bs = bars.current, ts = chart?.timeScale();
    if (!ts || !bs?.length) return null;
    const l = ts.coordinateToLogical(x);
    if (l == null) return null;
    const step = bs.length > 1 ? bs[bs.length - 1].t - bs[bs.length - 2].t : 60;
    const i = Math.floor(l);
    if (i >= bs.length - 1) return Math.round(bs[bs.length - 1].t + (l - (bs.length - 1)) * step);
    if (i < 0) return Math.round(bs[0].t + l * step);
    return Math.round(bs[i].t + (l - i) * (bs[i + 1].t - bs[i].t));
  }, [chart, bars]);

  const pointAt = useCallback((x: number, y: number): P | null => {
    const t = tOf(x), p = series?.coordinateToPrice(y);
    if (t == null || p == null) return null;
    if (!magnet) return { t, p };
    // Snap to the nearest open, high, low or close of the bar under the pointer when it's close.
    const bs = bars.current!, l = chart!.timeScale().coordinateToLogical(x);
    const b = l != null ? bs[Math.round(l)] : undefined;
    if (!b) return { t, p };
    const best = [b.o, b.h, b.l, b.c].map((v) => ({ v, d: Math.abs((series!.priceToCoordinate(v) ?? 1e9) - y) })).sort((a, z) => a.d - z.d)[0];
    return best.d < 14 ? { t: b.t, p: best.v } : { t, p };
  }, [tOf, series, magnet, chart, bars]);

  // Repaint every frame: cheap for a few dozen shapes, and it follows panning and price-scale drags exactly.
  useEffect(() => {
    let raf = 0;
    const paint = () => {
      raf = requestAnimationFrame(paint);
      const cv = canvas.current;
      if (!cv || !series) return;
      const dpr = window.devicePixelRatio || 1, w = cv.clientWidth, h = cv.clientHeight;
      if (cv.width !== w * dpr || cv.height !== h * dpr) { cv.width = w * dpr; cv.height = h * dpr; }
      const g = cv.getContext("2d")!;
      g.setTransform(dpr, 0, 0, dpr, 0, 0);
      g.clearRect(0, 0, w, h);
      const { items, draft, sel, hidden, accent } = state.current;
      const list = [...(hidden ? [] : items), ...(draft ? [draft] : [])];
      const font = getComputedStyle(cv).fontFamily;
      for (const d of list) {
        const col = d.color === "accent" ? accent : d.color;
        const x1 = xOf(d.a.t), y1 = series.priceToCoordinate(d.a.p);
        const x2 = d.b ? xOf(d.b.t) : null, y2 = d.b ? series.priceToCoordinate(d.b.p) : null;
        const on = d.id === sel;
        g.strokeStyle = col;
        g.fillStyle = col;
        g.lineWidth = on ? 2.5 : 1.6;
        g.setLineDash([]);
        g.font = `600 11px ${font}`;
        const label = (text: string, x: number, y: number, align: CanvasTextAlign = "left") => {
          g.textAlign = align;
          const m = g.measureText(text).width;
          const bx = align === "right" ? x - m - 6 : align === "center" ? x - m / 2 - 4 : x;
          g.fillStyle = "rgba(11,14,18,0.82)";
          g.fillRect(bx - 2, y - 13, m + 8, 17);
          g.fillStyle = col;
          g.fillText(text, align === "right" ? x - 4 : align === "center" ? x : x + 2, y);
        };
        if (d.kind === "hline" && y1 != null) {
          g.beginPath(); g.moveTo(0, y1); g.lineTo(w, y1); g.stroke();
          label(d.a.p.toFixed(2), w - 60, y1 - 4, "right");
        } else if (d.kind === "vline" && x1 != null) {
          g.beginPath(); g.moveTo(x1, 0); g.lineTo(x1, h); g.stroke();
        } else if (d.kind === "text" && x1 != null && y1 != null) {
          g.font = `600 13px ${font}`;
          label(d.text ?? "", x1, y1);
        } else if (x1 != null && y1 != null && x2 != null && y2 != null) {
          if (d.kind === "trend" || d.kind === "ray") {
            let ex: number = x2, ey: number = y2;
            if (d.kind === "ray" && x2 !== x1) { ex = w; ey = y1 + ((y2 - y1) * (w - x1)) / (x2 - x1); }
            g.beginPath(); g.moveTo(x1, y1); g.lineTo(ex, ey); g.stroke();
            for (const [cx, cy] of [[x1, y1], [x2, y2]]) { g.beginPath(); g.arc(cx, cy, on ? 4 : 2.5, 0, Math.PI * 2); g.fill(); }
          } else if (d.kind === "rect") {
            g.globalAlpha = 0.12; g.fillRect(x1, y1, x2 - x1, y2 - y1); g.globalAlpha = 1;
            g.strokeRect(x1, y1, x2 - x1, y2 - y1);
          } else if (d.kind === "fib") {
            const left = Math.min(x1, x2), right = Math.max(x1, x2, w - 70);
            FIB.forEach((f, i) => {
              const p = d.a.p + (d.b!.p - d.a.p) * (1 - f);
              const y = series.priceToCoordinate(p);
              if (y == null) return;
              g.globalAlpha = i % 2 ? 0.06 : 0.1;
              const next = FIB[i + 1] != null ? series.priceToCoordinate(d.a.p + (d.b!.p - d.a.p) * (1 - FIB[i + 1])) : null;
              if (next != null) g.fillRect(left, y, right - left, next - y);
              g.globalAlpha = f === 0.5 || f === 0.618 ? 1 : 0.7;
              g.beginPath(); g.moveTo(left, y); g.lineTo(right, y); g.stroke();
              g.globalAlpha = 1;
              label(`${(f * 100).toFixed(1)}%  ${p.toFixed(2)}`, left, y - 3);
            });
            g.setLineDash([4, 4]); g.globalAlpha = 0.5;
            g.beginPath(); g.moveTo(x1, y1); g.lineTo(x2, y2); g.stroke();
            g.globalAlpha = 1;
          } else if (d.kind === "measure") {
            const up = d.b!.p >= d.a.p;
            const c2 = up ? "#26b89a" : "#ef5a55";
            g.fillStyle = c2; g.strokeStyle = c2;
            g.globalAlpha = 0.14; g.fillRect(x1, y1, x2 - x1, y2 - y1); g.globalAlpha = 1;
            g.setLineDash([3, 3]); g.strokeRect(x1, y1, x2 - x1, y2 - y1); g.setLineDash([]);
            const bs = bars.current ?? [];
            const nb = bs.filter((b) => b.t > Math.min(d.a.t, d.b!.t) && b.t <= Math.max(d.a.t, d.b!.t)).length;
            const dp = d.b!.p - d.a.p;
            const txt = `${dp >= 0 ? "+" : ""}${dp.toFixed(2)}  (${dp >= 0 ? "+" : ""}${((dp / d.a.p) * 100).toFixed(2)}%)  ${nb} bars`;
            g.font = `700 12px ${font}`;
            const m = g.measureText(txt).width;
            const cx = (x1 + x2) / 2, cy = up ? Math.min(y1, y2) - 10 : Math.max(y1, y2) + 22;
            g.fillStyle = c2; g.fillRect(cx - m / 2 - 8, cy - 15, m + 16, 21);
            g.fillStyle = "#0b0e12"; g.textAlign = "center"; g.fillText(txt, cx, cy);
          }
        }
      }
    };
    raf = requestAnimationFrame(paint);
    return () => cancelAnimationFrame(raf);
  }, [series, xOf, bars]);

  // Pointer mode: clicking a drawing selects it (the chart keeps panning and zooming).
  useEffect(() => {
    if (!chart || !series) return;
    const onClick = (e: MouseEventParams<Time>) => {
      if (tool !== "cursor" || !e.point) return;
      const { x, y } = e.point;
      const hit = [...state.current.items].reverse().find((d) => {
        const x1 = xOf(d.a.t), y1 = series.priceToCoordinate(d.a.p);
        const x2 = d.b ? xOf(d.b.t) : null, y2 = d.b ? series.priceToCoordinate(d.b.p) : null;
        if (d.kind === "hline") return y1 != null && Math.abs(y - y1) < 6;
        if (d.kind === "vline") return x1 != null && Math.abs(x - x1) < 6;
        if (d.kind === "text") return x1 != null && y1 != null && x >= x1 - 4 && x <= x1 + 8 * (d.text?.length ?? 1) && Math.abs(y - y1 + 5) < 12;
        if (x1 == null || y1 == null || x2 == null || y2 == null) return false;
        if (d.kind === "rect" || d.kind === "fib") return x >= Math.min(x1, x2) - 4 && x <= Math.max(x1, x2) + 4 && y >= Math.min(y1, y2) - 4 && y <= Math.max(y1, y2) + 4;
        return distToSeg(x, y, x1, y1, x2, y2) < 6;
      });
      setSel(hit?.id ?? null);
    };
    chart.subscribeClick(onClick);
    return () => chart.unsubscribeClick(onClick);
  }, [chart, series, tool, xOf]);

  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement)?.tagName === "INPUT") return;
      if ((e.key === "Delete" || e.key === "Backspace") && sel) { commit(items.filter((d) => d.id !== sel)); setSel(null); }
      if (e.key === "Escape") { setDraft(null); setTool("cursor"); setNote(null); setSel(null); }
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, [sel, items, commit]);

  const local = (e: React.PointerEvent) => {
    const r = canvas.current!.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  };
  const spec = TOOLS.find((t) => t.key === tool)!;

  function down(e: React.PointerEvent) {
    if (tool === "cursor") return;
    const { x, y } = local(e);
    const at = pointAt(x, y);
    if (!at) return;
    if (tool === "text") { setNote({ x, y, at, text: "" }); return; }
    if (!spec.two) {
      commit([...items, { id: crypto.randomUUID(), kind: tool, a: at, color }]);
      setTool("cursor");
      return;
    }
    if (!draft) {
      (e.target as HTMLElement).setPointerCapture?.(e.pointerId);
      setDraft({ id: crypto.randomUUID(), kind: tool, a: at, b: at, color });
    }
  }
  function move(e: React.PointerEvent) {
    if (!draft) return;
    const { x, y } = local(e);
    const at = pointAt(x, y);
    if (at) setDraft({ ...draft, b: at });
  }
  function up(e: React.PointerEvent) {
    if (!draft) return;
    const { x, y } = local(e);
    const at = pointAt(x, y) ?? draft.b!;
    const x1 = xOf(draft.a.t) ?? 0;
    // A tap without a drag starts a two-click drawing; the second tap finishes it.
    if (Math.abs(x - x1) < 3 && Math.abs((series?.priceToCoordinate(draft.a.p) ?? 0) - y) < 3) return;
    const done = { ...draft, b: at };
    setDraft(null);
    if (done.kind === "measure") setItems([...items.filter((d) => d.kind !== "measure"), done]);
    else commit([...items, done]);
    setTool("cursor");
  }

  const selected = items.find((d) => d.id === sel);
  const swatch = (c: string) => (c === "accent" ? accent : c);
  const btn = (on: boolean) => `flex h-8 w-8 items-center justify-center rounded-lg transition-colors ${on ? "bg-gold text-black" : "text-muted hover:bg-surface-2 hover:text-foreground"}`;

  return (
    <>
      <canvas ref={canvas} onPointerDown={down} onPointerMove={move} onPointerUp={up}
        className={`absolute inset-0 z-[2] h-full w-full touch-none ${tool === "cursor" ? "pointer-events-none" : "cursor-crosshair"}`} />
      <div role="toolbar" aria-label="Drawing tools"
        className="absolute left-2 top-2 z-[3] flex max-h-[calc(100%-1rem)] flex-col gap-0.5 overflow-y-auto rounded-xl border border-border bg-surface/95 p-1 shadow-xl backdrop-blur">
        <button type="button" title={open ? "Fold the drawing tools" : "Drawing tools"} aria-label={open ? "Fold the drawing tools" : "Open drawing tools"} aria-expanded={open}
          onClick={() => { setOpen(!open); if (open) { setTool("cursor"); setDraft(null); } }} className={btn(false)}>
          <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
            <path d={open ? "M15 6l-6 6 6 6" : "M4 20h4L19 9l-4-4L4 16v4ZM13.5 6.5l4 4"} />
          </svg>
        </button>
        {open && <>
        <span className="my-0.5 h-px bg-border" />
        {TOOLS.map((t) => (
          <button key={t.key} type="button" title={t.label} aria-label={t.label} aria-pressed={tool === t.key}
            onClick={() => { setTool(t.key); setDraft(null); setSel(null); }} className={btn(tool === t.key)}>
            <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d={t.d} /></svg>
          </button>
        ))}
        <span className="my-0.5 h-px bg-border" />
        <button type="button" title={magnet ? "Magnet on: points snap to candle prices" : "Magnet off"} aria-pressed={magnet} onClick={() => setMagnet(!magnet)} className={btn(magnet)}>
          <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden><path d="M6 4v8a6 6 0 0 0 12 0V4h-4v8a2 2 0 0 1-4 0V4H6ZM6 8h4M14 8h4" /></svg>
        </button>
        <button type="button" title={hidden ? "Show drawings" : "Hide drawings"} aria-pressed={hidden} onClick={() => setHidden(!hidden)} className={btn(hidden)}>
          <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden>
            {hidden ? <path d="M3 3l18 18M10.6 6.1A9.8 9.8 0 0 1 12 6c5 0 9 6 9 6a17 17 0 0 1-3 3.4M6.4 6.4C4.2 8 3 12 3 12s4 6 9 6a8.8 8.8 0 0 0 4-1" /> : <><path d="M3 12s4-6 9-6 9 6 9 6-4 6-9 6-9-6-9-6Z" /><circle cx="12" cy="12" r="2.5" /></>}
          </svg>
        </button>
        <button type="button" title="Remove all drawings" onClick={() => setConfirmClear(!confirmClear)} disabled={!items.length} className={`${btn(false)} disabled:opacity-30`}>
          <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden><path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3" /></svg>
        </button>
        </>}
      </div>

      {(tool !== "cursor" || selected || confirmClear) && (
        <div className="absolute left-14 right-2 top-9 z-[3] flex sm:right-auto flex-wrap items-center gap-2 rounded-xl border border-border bg-surface/95 px-3 py-1.5 text-xs shadow-xl backdrop-blur">
          {confirmClear ? (
            <>
              <span>Remove all {items.length} drawings?</span>
              <button type="button" onClick={() => { commit([]); setConfirmClear(false); setSel(null); }} className="rounded-full bg-down px-2.5 py-0.5 font-medium text-black">Remove</button>
              <button type="button" onClick={() => setConfirmClear(false)} className="text-muted">Keep</button>
            </>
          ) : selected ? (
            <>
              <span className="text-muted">Selected {TOOLS.find((t) => t.key === selected.kind)?.label.split(":")[0].toLowerCase()}</span>
              {COLORS.map((c) => (
                <button key={c} type="button" aria-label="Colour" onClick={() => commit(items.map((d) => (d.id === sel ? { ...d, color: c } : d)))}
                  className={`h-4 w-4 rounded-full ring-offset-1 ring-offset-surface ${selected.color === c ? "ring-2 ring-foreground" : ""}`} style={{ background: swatch(c) }} />
              ))}
              <button type="button" onClick={() => { commit(items.filter((d) => d.id !== sel)); setSel(null); }} className="rounded-full border border-down/50 px-2.5 py-0.5 text-down">Delete</button>
            </>
          ) : (
            <>
              <span>{spec.label}. {spec.two ? "Drag, or tap two points." : "Tap the chart."}</span>
              {tool !== "measure" && COLORS.map((c) => (
                <button key={c} type="button" aria-label="Colour" onClick={() => setColor(c)}
                  className={`h-4 w-4 rounded-full ring-offset-1 ring-offset-surface ${color === c ? "ring-2 ring-foreground" : ""}`} style={{ background: swatch(c) }} />
              ))}
              <button type="button" onClick={() => { setTool("cursor"); setDraft(null); }} className="text-muted hover:text-foreground">Cancel</button>
            </>
          )}
        </div>
      )}

      {note && (
        <form className="absolute z-[4]" style={{ left: note.x, top: note.y - 16 }}
          onSubmit={(e) => {
            e.preventDefault();
            if (note.text.trim()) commit([...items, { id: crypto.randomUUID(), kind: "text", a: note.at, text: note.text.trim().slice(0, 80), color }]);
            setNote(null);
            setTool("cursor");
          }}>
          <input autoFocus value={note.text} onChange={(e) => setNote({ ...note, text: e.target.value })} onBlur={(e) => e.currentTarget.form?.requestSubmit()}
            placeholder="Type a note, then Enter" maxLength={80}
            className="w-52 rounded-lg border border-gold bg-surface px-2 py-1 text-sm shadow-xl outline-none" />
        </form>
      )}
    </>
  );
}
