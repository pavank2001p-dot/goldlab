"use client";

import Link from "next/link";
import { useEffect, useRef } from "react";
import { fmtUsd, type Twin, type TwinDay } from "@/lib/api";

const signed = (v: number) => `${v > 0 ? "+" : v < 0 ? "-" : ""}${fmtUsd(Math.abs(v))}`;

/** Your running result and the twin's, on one scale, with the gap shaded. */
function Curves({ curve }: { curve: Twin["curve"] }) {
  const W = 640, H = 200, pad = 14;
  const pts = [{ you: 0, twin: 0 }, ...curve];
  const vals = pts.flatMap((p) => [p.you, p.twin]);
  const lo = Math.min(0, ...vals), hi = Math.max(0, ...vals), span = hi - lo || 1;
  const x = (i: number) => (i / Math.max(1, pts.length - 1)) * W;
  const y = (v: number) => pad + (1 - (v - lo) / span) * (H - pad * 2);
  const line = (k: "you" | "twin") => pts.map((p, i) => `${x(i).toFixed(1)},${y(p[k]).toFixed(1)}`).join(" ");
  const gap = `${line("twin")} ${pts.map((p, i) => `${x(i).toFixed(1)},${y(p.you).toFixed(1)}`).reverse().join(" ")}`;
  const last = pts[pts.length - 1];
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="h-auto w-full" role="img" aria-label="Your running result against your twin's">
      <line x1={0} x2={W} y1={y(0)} y2={y(0)} stroke="var(--border)" />
      <polygon points={gap} fill={last.twin >= last.you ? "var(--down)" : "var(--up)"} fillOpacity={0.12} />
      <polyline points={line("you")} fill="none" stroke="var(--foreground)" strokeWidth={2} strokeLinejoin="round" vectorEffect="non-scaling-stroke" />
      <polyline points={line("twin")} fill="none" stroke="var(--up)" strokeWidth={2.2} strokeLinejoin="round" vectorEffect="non-scaling-stroke" />
      <text x={W - 4} y={Math.max(12, y(last.twin) - 6)} textAnchor="end" fontSize={11} fontWeight={600} fill="var(--up)">twin</text>
      <text x={W - 4} y={Math.min(H - 4, y(last.you) + 16)} textAnchor="end" fontSize={11} fontWeight={600} fill="var(--foreground)">you</text>
    </svg>
  );
}

export function TwinCard({ t }: { t: Twin }) {
  if (!t.trades.length) return null;
  const gap = t.twin - t.you;
  return (
    <section className="card space-y-4 p-4 sm:p-5">
      <div>
        <h2 className="text-lg font-semibold">Your disciplined twin</h2>
        <p className="mt-1 text-sm text-muted">
          A copy of you took every paper trade at the same moment, but kept the rules: your planned stop, a stop on every trade,
          {` ${t.limit_pct}%`} risk at most, and no trade straight after a loss or next to a big release.
        </p>
      </div>
      <div className="grid grid-cols-3 gap-3">
        <div><p className="text-xs text-muted">You</p><p className={`text-xl font-bold tabular-nums ${t.you >= 0 ? "text-up" : "text-down"}`}>{signed(t.you)}</p></div>
        <div><p className="text-xs text-muted">Your twin</p><p className={`text-xl font-bold tabular-nums ${t.twin >= 0 ? "text-up" : "text-down"}`}>{signed(t.twin)}</p></div>
        <div>
          <p className="text-xs text-muted">{gap >= 0 ? "Cost of breaking rules" : "Breaking rules paid off"}</p>
          <p className={`text-xl font-bold tabular-nums ${gap > 0 ? "text-down" : gap < 0 ? "text-up" : ""}`}>{gap > 0 ? "-" : gap < 0 ? "+" : ""}{fmtUsd(Math.abs(gap))}</p>
        </div>
      </div>
      <div className="rounded-xl border border-border bg-background/40 p-2"><Curves curve={t.curve} /></div>
      {t.costs.length ? (
        <ul className="space-y-1.5 text-sm">
          {t.costs.map((c) => (
            <li key={c.tag} className="flex items-baseline justify-between gap-3">
              <span>{c.label} <span className="text-muted">({c.trades} trade{c.trades === 1 ? "" : "s"})</span></span>
              <span className={`tabular-nums ${c.cost < 0 ? "text-down" : "text-up"}`}>{c.cost < 0 ? "-" : "+"}{fmtUsd(Math.abs(c.cost))}</span>
            </li>
          ))}
        </ul>
      ) : <p className="text-sm text-up">You and your twin traded the same way. That is the goal.</p>}
      <p className="text-xs text-muted">
        A minus means the habit cost you money against the twin. Sometimes a broken rule pays off; the twin shows whether it does over many trades.
        Spread and swap are left out of the twin&apos;s changes. Set your limit with the <Link href="/risk" className="text-gold hover:underline">risk quiz</Link>.
      </p>
    </section>
  );
}

function rng(seed: string) {
  let h = 2166136261;
  for (const ch of seed) h = Math.imul(h ^ ch.charCodeAt(0), 16777619);
  return () => {
    h = Math.imul(h ^ (h >>> 15), 2246822507);
    h = Math.imul(h ^ (h >>> 13), 3266489909);
    return ((h ^= h >>> 16) >>> 0) / 4294967296;
  };
}

/** One emblem per day: a ring per trade, jagged when rules were broken, the outer ring green or red by result. */
function Glyph({ d, size = 72 }: { d: TwinDay | null; size?: number }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const cv = ref.current;
    if (!cv) return;
    const css = getComputedStyle(document.documentElement);
    const col = (n: string) => css.getPropertyValue(n).trim();
    const dpr = window.devicePixelRatio || 1;
    cv.width = size * dpr;
    cv.height = size * dpr;
    const g = cv.getContext("2d")!;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, size, size);
    g.translate(size / 2, size / 2);
    if (!d) {
      g.beginPath(); g.arc(0, 0, 2, 0, Math.PI * 2); g.fillStyle = col("--border"); g.fill();
      return;
    }
    const r = rng(d.day);
    const rings = Math.min(d.trades, 6);
    const rough = d.broken / d.trades;
    const step = (size / 2 - 8) / Math.max(rings, 1);
    for (let k = 0; k < rings; k++) {
      const rad = 7 + step * (k + 1) - step / 2;
      g.beginPath();
      for (let s = 0; s <= 60; s++) {
        const a = (s / 60) * Math.PI * 2;
        const j = rough > 0 ? (r() - 0.5) * 6 * rough : Math.sin(a * 3 + k) * 0.8;
        const rr = rad + j;
        if (s) g.lineTo(Math.cos(a) * rr, Math.sin(a) * rr); else g.moveTo(Math.cos(a) * rr, Math.sin(a) * rr);
      }
      const outer = k === rings - 1;
      g.strokeStyle = outer ? col(d.pnl >= 0 ? "--up" : "--down") : col(k % 2 ? "--gold" : "--muted");
      g.globalAlpha = outer ? 1 : 0.45 + 0.4 * (k / rings);
      g.lineWidth = outer ? 2.2 : 1.6;
      g.stroke();
    }
    g.globalAlpha = 1;
    g.beginPath(); g.arc(0, 0, 3, 0, Math.PI * 2); g.fillStyle = col(d.broken ? "--down" : "--up"); g.fill();
  }, [d, size]);
  return <canvas ref={ref} style={{ width: "100%", maxWidth: size, height: "auto" }} aria-hidden />;
}

const DAYS = 35;

export function GlyphWall({ days }: { days: TwinDay[] }) {
  if (!days.length) return null;
  const by = new Map(days.map((d) => [d.day, d]));
  const end = new Date(`${days[days.length - 1].day}T00:00:00Z`);
  const today = new Date();
  const last = today > end ? new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate())) : end;
  const cells = Array.from({ length: DAYS }, (_, i) => {
    const d = new Date(last.getTime() - (DAYS - 1 - i) * 86_400_000).toISOString().slice(0, 10);
    return { key: d, d: by.get(d) ?? null };
  });
  const traded = cells.filter((c) => c.d);
  const clean = traded.filter((c) => c.d!.broken === 0).length;
  return (
    <section className="card space-y-3 p-4 sm:p-5">
      <div>
        <h2 className="text-lg font-semibold">Session glyphs</h2>
        <p className="mt-1 text-sm text-muted">
          Each trading day draws its own emblem: a ring per trade, smooth when every rule was kept, jagged when one was broken,
          and the outer ring green or red by the day&apos;s result. {traded.length ? `${clean} of ${traded.length} trading days in the last five weeks were clean.` : ""}
        </p>
      </div>
      <div className="grid grid-cols-7 gap-1.5">
        {cells.map((c) => (
          <div key={c.key} className="flex aspect-square items-center justify-center rounded-lg bg-background/50"
            title={c.d ? `${c.key}: ${c.d.trades} trade${c.d.trades === 1 ? "" : "s"}, ${signed(c.d.pnl)}, ${c.d.broken} broke a rule` : `${c.key}: no trades`}>
            <Glyph d={c.d} />
          </div>
        ))}
      </div>
    </section>
  );
}
