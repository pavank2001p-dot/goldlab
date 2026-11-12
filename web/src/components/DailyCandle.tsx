"use client";

import { useEffect, useRef, useState } from "react";
import { api, type DailyCandle as Daily, type DailyChoice, type DailyResult, type LevelBar } from "@/lib/api";
import { useUser } from "@/lib/useUser";
import ShareButton from "./ShareCard";
import { Icon } from "./ui";

const LOCAL = "goldlab-daily-candle";
const REVEAL_MS = 7000;
const SHOWN = 40; // of the hidden hours, how many of the latest are drawn

const pct = (v: number, d = 2) => `${v >= 0 ? "+" : ""}${v.toFixed(d)}%`;
const usd = (v: number) => `${v < 0 ? "-" : "+"}$${Math.abs(v).toFixed(2)}`;
const LABEL: Record<DailyChoice, string> = { buy: "Buy", sell: "Sell", wait: "Wait" };

function readLocal(day: string): DailyResult | null {
  try {
    const v = JSON.parse(localStorage.getItem(LOCAL) ?? "null");
    return v?.day === day ? (v.result as DailyResult) : null;
  } catch { return null; }
}
function writeLocal(day: string, result: DailyResult) {
  try { localStorage.setItem(LOCAL, JSON.stringify({ day, result })); } catch {}
}

/** Candles drawn on one scale; the hidden hours are a shaded band until they play out. */
function Candles({ past, future, shown, horizon }: { past: LevelBar[]; future: LevelBar[]; shown: number; horizon: number }) {
  const W = 640, H = 220, pad = 10;
  const bars = [...past, ...future.slice(0, shown)];
  const n = past.length + horizon;
  const all = [...past, ...future].flatMap((b) => [b.h, b.l]);
  const lo = Math.min(...all), hi = Math.max(...all), span = hi - lo || 1;
  const y = (v: number) => pad + (1 - (v - lo) / span) * (H - pad * 2);
  const cw = W / n, fx = past.length * cw;
  const hiddenLeft = shown < horizon;
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="h-auto w-full" role="img"
      aria-label={hiddenLeft ? "Hourly candles up to the moment, with the next hours hidden" : "Hourly candles with the next hours revealed"}>
      {[1, 2, 3].map((i) => <line key={i} x1={0} x2={W} y1={(H * i) / 4} y2={(H * i) / 4} stroke="var(--border)" strokeOpacity={0.6} />)}
      <rect x={fx} y={0} width={W - fx} height={H} fill="var(--gold)" fillOpacity={0.07} />
      <line x1={fx} x2={fx} y1={0} y2={H} stroke="var(--gold)" strokeDasharray="4 4" strokeOpacity={0.8} />
      <line x1={0} x2={W} y1={y(100)} y2={y(100)} stroke="var(--muted)" strokeDasharray="2 5" strokeOpacity={0.6} />
      {bars.map((b, i) => {
        const x = i * cw + cw / 2, up = b.c >= b.o, col = up ? "var(--up)" : "var(--down)";
        const top = y(Math.max(b.o, b.c)), h = Math.max(1.2, Math.abs(y(b.o) - y(b.c)));
        return (
          <g key={i} opacity={i < past.length - SHOWN ? 0.35 : 1}>
            <line x1={x} x2={x} y1={y(b.h)} y2={y(b.l)} stroke={col} strokeWidth={1} />
            <rect x={x - cw * 0.32} width={cw * 0.64} y={top} height={h} fill={col} rx={0.6} />
          </g>
        );
      })}
      {hiddenLeft && shown === 0 && (
        <text x={fx + (W - fx) / 2} y={H / 2 + 12} textAnchor="middle" fontSize={40} fontWeight={700} fill="var(--gold)" className="breathe">?</text>
      )}
      <text x={fx - 6} y={H - 6} textAnchor="end" fontSize={11} fill="var(--muted)">now</text>
      <text x={W - 6} y={H - 6} textAnchor="end" fontSize={11} fill="var(--muted)">next {horizon} hours</text>
    </svg>
  );
}

function Crowd({ c, mine }: { c: DailyResult["crowd"]; mine: DailyChoice }) {
  if (c.total < 3) return <p className="text-xs text-muted">Too few players yet to show how everyone chose.</p>;
  const rows: DailyChoice[] = ["buy", "sell", "wait"];
  return (
    <div className="space-y-1.5">
      <p className="text-xs text-muted">How {c.total.toLocaleString("en-US")} players chose</p>
      {rows.map((k) => {
        const share = (c[k] / c.total) * 100;
        return (
          <div key={k} className="flex items-center gap-2 text-xs">
            <span className={`w-10 ${k === mine ? "font-semibold text-foreground" : "text-muted"}`}>{LABEL[k]}</span>
            <span className="h-2 flex-1 overflow-hidden rounded-full bg-border">
              <span className={`block h-full rounded-full ${k === "buy" ? "bg-up" : k === "sell" ? "bg-down" : "bg-muted"}`} style={{ width: `${share}%` }} />
            </span>
            <span className="w-9 text-right tabular-nums text-muted">{share.toFixed(0)}%</span>
          </div>
        );
      })}
    </div>
  );
}

function story(r: DailyResult): string {
  const dir = r.move_pct >= 0 ? "rose" : "fell";
  const swing = r.move_pct >= 0 ? r.low_pct : r.high_pct;
  const shake = Math.abs(swing) >= 0.15
    ? ` On the way it ${swing < 0 ? "dipped" : "spiked"} ${pct(swing)} first, which would have tested a tight stop.`
    : " It went that way with barely a pullback.";
  return `Over the next 12 hours gold ${dir} ${Math.abs(r.move_pct).toFixed(2)}%, from $${r.price.toFixed(2)} to $${r.end_price.toFixed(2)}.${shake}`;
}

function Result({ r, d }: { r: DailyResult; d: Daily }) {
  const when = new Date(r.at * 1000);
  const date = when.toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "long", year: "numeric", timeZone: "UTC" });
  const time = when.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", timeZone: "UTC" });
  const head = r.choice === "wait"
    ? r.right ? "Waiting was the calm call." : `You waited. A ${r.best === "buy" ? "buyer" : "seller"} would have done well.`
    : r.right ? `Good read. ${LABEL[r.choice]} was right.` : `Not this time. ${LABEL[r.best]} fitted better.`;
  return (
    <div className="rise-in grid gap-4 md:grid-cols-[1.2fr_1fr]">
      <div className="space-y-2">
        <p className="text-xs uppercase tracking-wider text-muted">The moment was</p>
        <p className="text-lg font-semibold">{date}, {time} UTC</p>
        <p className={`text-xl font-bold ${r.right ? "text-up" : "text-foreground"}`}>{head}</p>
        <p className="text-sm leading-relaxed text-muted">{story(r)}</p>
      </div>
      <div className="space-y-3 rounded-xl bg-background/60 p-4">
        <div className="grid grid-cols-2 gap-3 text-sm">
          <div>
            <p className="text-xs text-muted">$1,000 {r.choice === "wait" ? "kept aside" : r.choice === "buy" ? "bought" : "sold"}</p>
            <p className={`text-lg font-semibold tabular-nums ${r.pnl_1000 > 0 ? "text-up" : r.pnl_1000 < 0 ? "text-down" : ""}`}>
              {r.choice === "wait" ? "$0.00" : usd(r.pnl_1000)}
            </p>
          </div>
          <div>
            <p className="text-xs text-muted">Worst moment against you</p>
            <p className="text-lg font-semibold tabular-nums">{r.choice === "wait" ? "None" : `-${r.against_pct.toFixed(2)}%`}</p>
          </div>
        </div>
        <Crowd c={r.crowd} mine={r.choice} />
        {r.you && (
          <p className="flex items-center gap-1.5 text-xs text-muted">
            <Icon name="trophy" className="h-3.5 w-3.5 text-gold" />
            {r.you.streak} day{r.you.streak === 1 ? "" : "s"} in a row · {r.you.right} of {r.you.played} calls fitted the move
          </p>
        )}
        <ShareButton className="w-full" data={{
          kind: "Daily Candle",
          title: `Daily Candle #${d.number}: I chose ${LABEL[r.choice]}`,
          subtitle: `${date}. Gold ${r.move_pct >= 0 ? "rose" : "fell"} ${Math.abs(r.move_pct).toFixed(2)}% in the next 12 hours.`,
          stats: [
            { label: "My call", value: LABEL[r.choice] },
            { label: "Move", value: pct(r.move_pct), tone: r.move_pct >= 0 ? "up" : "down" },
            { label: "Best call", value: LABEL[r.best] },
          ],
          equity: [...d.bars, ...r.future].map((b) => b.c),
          footnote: "One real moment of gold history a day, practised with no money at stake.",
        }} />
      </div>
    </div>
  );
}

/** One hidden moment of gold history a day: buy, sell or wait, then watch the next twelve hours. */
export default function DailyCandle() {
  const { user } = useUser();
  const [d, setD] = useState<Daily | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<DailyResult | null>(null);
  const [shown, setShown] = useState(0);
  const [busy, setBusy] = useState(false);
  const raf = useRef<number | null>(null);

  useEffect(() => {
    if (user === undefined) return;
    api.daily().then((x) => {
      setD(x);
      const done = x.played ?? (user ? null : readLocal(x.day));
      if (done) { setResult(done); setShown(x.horizon); }
    }, (e) => setError(e.message));
  }, [user]);

  useEffect(() => () => { if (raf.current) cancelAnimationFrame(raf.current); }, []);

  function reveal(total: number) {
    const reduce = matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (reduce) { setShown(total); return; }
    const t0 = performance.now();
    const step = (t: number) => {
      const k = Math.min(1, (t - t0) / REVEAL_MS);
      setShown(Math.ceil(k * total));
      if (k < 1) raf.current = requestAnimationFrame(step);
    };
    raf.current = requestAnimationFrame(step);
  }

  async function choose(c: DailyChoice) {
    if (!d || busy) return;
    setBusy(true);
    try {
      const r = await api.playDaily(c);
      setResult(r);
      if (!user) writeLocal(d.day, r);
      reveal(d.horizon);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't send your choice. Try again.");
    } finally { setBusy(false); }
  }

  if (error && !d) return null; // no history yet: the home page simply goes without it
  const revealing = result != null && shown < (d?.horizon ?? 0);

  return (
    <section className="card mt-6 space-y-4 p-4 sm:p-6" aria-labelledby="daily-candle-title">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <p className="text-xs uppercase tracking-wider text-gold">Daily Candle{d ? ` #${d.number}` : ""}</p>
          <h2 id="daily-candle-title" className="mt-1 text-xl font-bold">
            {result ? "Here is what happened next" : "A real moment from gold's past. What do you do?"}
          </h2>
        </div>
        <p className="max-w-xs text-xs text-muted">
          {result ? "A new moment arrives every day at midnight UTC." : "Date and price are hidden until you choose, so you can't look it up. One go a day."}
        </p>
      </div>

      <div className="rounded-xl border border-border bg-background/40 p-2">
        {d ? <Candles past={d.bars.slice(-SHOWN - 32)} future={result?.future ?? []} shown={result ? shown : 0} horizon={d.horizon} />
          : <div className="aspect-[640/220] animate-pulse rounded-lg bg-surface-2" />}
      </div>

      {!result && (
        <div className="space-y-2">
          <p className="text-sm text-muted">Hourly gold candles, the last three days. The shaded band is the next 12 hours.</p>
          <div className="grid grid-cols-3 gap-2">
            {(["buy", "sell", "wait"] as DailyChoice[]).map((c) => (
              <button key={c} type="button" disabled={!d || busy} onClick={() => choose(c)}
                className={`rounded-xl border py-3 text-sm font-semibold transition-colors disabled:opacity-50 ${
                  c === "buy" ? "border-up/60 text-up hover:bg-up/10" : c === "sell" ? "border-down/60 text-down hover:bg-down/10" : "border-border text-muted hover:bg-surface-2"}`}>
                {LABEL[c]}
              </button>
            ))}
          </div>
          {error && <p className="text-sm text-down">{error}</p>}
        </div>
      )}

      {result && d && (revealing
        ? <p className="text-sm text-muted">You chose <span className="font-semibold text-foreground">{LABEL[result.choice]}</span>. Playing the next 12 hours…</p>
        : <Result r={result} d={d} />)}
    </section>
  );
}
