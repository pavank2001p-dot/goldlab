"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import FitPanel from "@/components/FitPanel";
import PriceChart from "@/components/PriceChart";
import TradeLines, { type TradeActions } from "@/components/chart/TradeLines";
import ReportView from "@/components/ReportView";
import SignInPrompt from "@/components/SignInPrompt";
import { Chips, CountUp, Empty, Icon, PageHeader, SidePill } from "@/components/ui";
import {
  api, fmtUsd, type Market, type PaperOrder, type PaperOrderInput, type PaperPosition, type PaperState, type Report, type RiskProfile,
} from "@/lib/api";
import MarketPicker from "@/components/markets/MarketPicker";
import { GOLD, unitsLabel, useMarket } from "@/lib/markets";
import AccountSetup, { SETUP_KEY } from "@/components/paper/AccountSetup";
import LeveragePicker from "@/components/paper/LeveragePicker";
import { toast } from "@/components/Toaster";
import { useUser } from "@/lib/useUser";
import AlertsCard from "@/components/practice/AlertsCard";
import Insights from "@/components/practice/Insights";
import SizeCalculator from "@/components/practice/SizeCalculator";
import TradeReview from "@/components/practice/TradeReview";

type Side = "long" | "short";
type Kind = "market" | "limit" | "stop";
type Tab = "positions" | "orders" | "history" | "report" | "habits";

const POLL_MS = 5000;
// Quick sizes as multiples of the market's usual trade (1, 5, 10, 50 and 100 oz for gold).
const SIZE_STEPS = [0.2, 1, 2, 10, 20];
/** Short unit for sizes: "oz" for metals, otherwise "shares", "barrels", "units"... */
const unitShort = (m: Pick<Market, "unit">, n?: number) => (m.unit === "ounce" ? "oz" : unitsLabel(m, n));
const BALANCES = [1_000, 10_000, 100_000, 1_000_000, 10_000_000];
const short = (v: number) =>
  v >= 1e12 ? `$${+(v / 1e12).toFixed(2)}T` : v >= 1e9 ? `$${+(v / 1e9).toFixed(2)}B` : v >= 1e6 ? `$${+(v / 1e6).toFixed(2)}M` : v >= 1e3 ? `$${+(v / 1e3).toFixed(1)}k` : `$${v}`;
const REASON: Record<string, string> = {
  manual: "Closed by you",
  stop_loss: "Stop loss hit",
  take_profit: "Take profit hit",
  stop_out: "Margin stop-out",
  agent: "Closed by the agent",
};
const KIND_HELP: Record<Kind, string> = {
  market: "Fills now at the current price.",
  limit: "Waits for a better price: a buy below the ask, a sell above the bid.",
  stop: "Waits for the price to break through: a buy above the ask, a sell below the bid.",
};

const input = "w-full rounded-lg border border-border bg-background px-3 py-2 text-base tabular-nums outline-none transition focus:border-gold sm:text-sm";
const px = (v: number | null | undefined, d = 2) => (v == null ? "–" : v.toLocaleString("en-US", { minimumFractionDigits: d, maximumFractionDigits: d }));
const signed = (v: number | null | undefined) => (v == null ? "–" : `${v > 0 ? "+" : ""}${fmtUsd(v)}`);
const tone = (v: number | null | undefined) => (v == null || v === 0 ? "text-muted" : v > 0 ? "text-up" : "text-down");
const num = (v: string) => (v.trim() === "" ? null : Number(v));
const when = (iso: string) => new Date(iso).toLocaleString(undefined, { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });

function ago(s: number) {
  if (s < 90) return "just now";
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400 * 2) return `${Math.round(s / 3600)} h ago`;
  return `${Math.round(s / 86400)} days ago`;
}

/** Bid and ask, flashing green or red when they move. */
function Quote({ price, market }: { price: PaperState["price"]; market: Market }) {
  const last = useRef<number | null>(null);
  const [flash, setFlash] = useState<"up" | "down" | null>(null);
  useEffect(() => {
    if (!price) return;
    if (last.current != null && price.bid !== last.current) {
      setFlash(price.bid > last.current ? "up" : "down");
      const id = setTimeout(() => setFlash(null), 700);
      last.current = price.bid;
      return () => clearTimeout(id);
    }
    last.current = price.bid;
  }, [price]);
  if (!price) return <p className="text-sm text-muted">No price yet</p>;
  const cls = flash === "up" ? "text-up" : flash === "down" ? "text-down" : "";
  return (
    <div className="flex flex-wrap items-center gap-x-5 gap-y-2">
      <div>
        <p className="text-[11px] uppercase tracking-wide text-muted">Sell at (bid)</p>
        <p className={`text-xl font-semibold tabular-nums transition-colors ${cls}`}>{px(price.bid, market.decimals)}</p>
      </div>
      <div>
        <p className="text-[11px] uppercase tracking-wide text-muted">Buy at (ask)</p>
        <p className={`text-xl font-semibold tabular-nums transition-colors ${cls}`}>{px(price.ask, market.decimals)}</p>
      </div>
      <span className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs ${price.open ? "bg-up/15 text-up" : "bg-border text-muted"}`}>
        <span className={`h-1.5 w-1.5 rounded-full ${price.open ? "breathe bg-up" : "bg-muted"}`} />
        {price.open ? (price.source === "live" ? "Live" : `Updated ${ago(price.age_seconds)}`) : `Market closed · last price ${ago(price.age_seconds)}`}
      </span>
    </div>
  );
}

function Stat({ label, children, hint, icon }: { label: string; children: React.ReactNode; hint?: React.ReactNode; icon: string }) {
  return (
    <div className="rounded-2xl border border-border bg-surface p-3.5">
      <p className="flex items-center gap-1.5 text-xs text-muted"><Icon name={icon} className="h-3.5 w-3.5" />{label}</p>
      <p className="mt-1 text-lg font-semibold tabular-nums">{children}</p>
      {hint && <p className="mt-0.5 text-xs text-muted">{hint}</p>}
    </div>
  );
}

/** Where the price sits between the stop loss and the take profit. */
function Track({ p, d = 2 }: { p: PaperPosition; d?: number }) {
  if (p.mark == null || (p.stop_loss == null && p.take_profit == null)) return <span className="text-xs text-muted">No stop or target</span>;
  const long = p.side === "long";
  // Left end is the stop (or the entry), right end the target (or the entry), in the trade's direction.
  const lo = p.stop_loss ?? p.entry_price, hi = p.take_profit ?? p.entry_price;
  const span = hi - lo || 1;
  const at = (v: number) => Math.min(Math.max((v - lo) / span, 0), 1) * 100;
  const mark = at(p.mark), entry = at(p.entry_price);
  return (
    <div className="w-32">
      <div className="relative h-1.5 rounded-full bg-gradient-to-r from-down/60 via-border to-up/60">
        <span className="absolute top-1/2 h-3 w-px -translate-y-1/2 bg-muted" style={{ left: `${entry}%` }} title="Entry" />
        <span className="absolute top-1/2 h-2.5 w-2.5 -translate-x-1/2 -translate-y-1/2 rounded-full bg-gold transition-all"
              style={{ left: `${mark}%` }} />
      </div>
      <div className="mt-1 flex justify-between text-[10px] tabular-nums text-muted">
        <span>{p.stop_loss != null ? `SL ${px(p.stop_loss, d)}` : ""}</span>
        <span>{p.take_profit != null ? `TP ${px(p.take_profit, d)}` : ""}</span>
      </div>
      {!long && <span className="sr-only">Short position</span>}
    </div>
  );
}

function PositionRow({ p, m, onClose, onSave, busy }: {
  p: PaperPosition;
  m: Market;
  onClose: () => void;
  onSave: (sl: number | null, tp: number | null) => Promise<boolean>;
  busy: boolean;
}) {
  const [edit, setEdit] = useState(false);
  const [sl, setSl] = useState(p.stop_loss?.toString() ?? "");
  const [tp, setTp] = useState(p.take_profit?.toString() ?? "");
  return (
    <div className="rise-in rounded-2xl border border-border bg-surface p-3.5">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <SidePill side={p.side} />
        <span className="text-sm tabular-nums">{p.units} {unitShort(m, p.units)}{m.symbol !== GOLD.symbol || p.symbol !== GOLD.symbol ? <span className="text-muted"> {m.name}</span> : null}</span>
        <span className="text-xs text-muted tabular-nums">from {px(p.entry_price, m.decimals)} → now {px(p.mark, m.decimals)}</span>
        <span className={`ml-auto text-lg font-semibold tabular-nums ${tone(p.pnl)}`}>{signed(p.pnl)}</span>
      </div>
      <div className="mt-3 flex flex-wrap items-center gap-3">
        <Track p={p} d={m.decimals} />
        <span className="text-xs text-muted">Opened {when(p.opened_at)}{p.order_kind !== "market" && ` · ${p.order_kind} order`}</span>
        <div className="ml-auto flex gap-2">
          <button onClick={() => setEdit(!edit)} className="rounded-lg border border-border px-3 py-1.5 text-xs transition hover:border-muted">
            {edit ? "Cancel" : "Edit stop / target"}
          </button>
          <button onClick={onClose} disabled={busy} className="rounded-lg bg-foreground px-3 py-1.5 text-xs font-medium text-background transition hover:opacity-90 disabled:opacity-50">
            Close
          </button>
        </div>
      </div>
      {edit && (
        <form className="quiz-in mt-3 flex flex-wrap items-end gap-2" onSubmit={async (e) => {
          e.preventDefault();
          if (await onSave(num(sl), num(tp))) setEdit(false);
        }}>
          <label className="text-xs text-muted">Stop loss<input value={sl} onChange={(e) => setSl(e.target.value)} inputMode="decimal" className={`${input} mt-1 w-32`} placeholder="none" /></label>
          <label className="text-xs text-muted">Take profit<input value={tp} onChange={(e) => setTp(e.target.value)} inputMode="decimal" className={`${input} mt-1 w-32`} placeholder="none" /></label>
          <button disabled={busy} className="rounded-lg bg-gold px-3 py-2 text-xs font-medium text-black disabled:opacity-50">Save</button>
        </form>
      )}
    </div>
  );
}

function OrderRow({ o, m, price, onCancel, busy }: {
  o: PaperOrder; m: Market; price: PaperState["price"]; onCancel: () => void; busy: boolean;
}) {
  // The gap to now only makes sense when the price shown is this order's market.
  const same = (price?.symbol ?? GOLD.symbol) === (o.symbol ?? GOLD.symbol);
  const ref = price && same ? (o.side === "long" ? price.ask : price.bid) : null;
  const gap = ref != null ? o.price - ref : null;
  return (
    <div className="rise-in flex flex-wrap items-center gap-x-4 gap-y-2 rounded-2xl border border-dashed border-border bg-surface/60 p-3.5">
      <SidePill side={o.side} />
      <span className="rounded-full bg-border px-2 py-0.5 text-[11px] capitalize">{o.kind}</span>
      <span className="text-sm tabular-nums">{o.units} {unitShort(m, o.units)}{(o.symbol ?? GOLD.symbol) !== GOLD.symbol ? ` ${m.name}` : ""} at {px(o.price, m.decimals)}</span>
      {gap != null && <span className="text-xs text-muted tabular-nums">{Math.abs(gap).toFixed(m.decimals)} {gap > 0 ? "above" : "below"} now</span>}
      <span className="text-xs text-muted tabular-nums">
        {o.stop_loss != null && `SL ${px(o.stop_loss, m.decimals)} `}{o.take_profit != null && `TP ${px(o.take_profit, m.decimals)}`}
      </span>
      <button onClick={onCancel} disabled={busy} className="ml-auto rounded-lg border border-border px-3 py-1.5 text-xs transition hover:border-down hover:text-down disabled:opacity-50">
        Cancel
      </button>
    </div>
  );
}

function Ticket({ state, market, profile, onPlaced, busy, setBusy, preset }: {
  preset?: { oz: number; n: number } | null;
  state: PaperState;
  market: Market;
  profile: RiskProfile | null;
  onPlaced: (msg: string | null) => Promise<void>;
  busy: boolean;
  setBusy: (b: boolean) => void;
}) {
  const [side, setSide] = useState<Side>("long");
  const [kind, setKind] = useState<Kind>("market");
  const [units, setUnits] = useState(String(market.default_units * 2));
  const d = market.decimals;
  const ux = (n?: number) => unitShort(market, n);
  const sizes = SIZE_STEPS.map((k) => +(market.default_units * k).toPrecision(6));
  useEffect(() => { setUnits(String(market.default_units * 2)); }, [market.symbol, market.default_units]);
  const [price, setPrice] = useState("");
  const [useSl, setUseSl] = useState(true);
  const [useTp, setUseTp] = useState(false);
  const [sl, setSl] = useState("");
  const [tp, setTp] = useState("");
  const [error, setError] = useState<string | null>(null);
  useEffect(() => { if (preset) setUnits(String(preset.oz)); }, [preset]);
  // Orders go through a short review first, so the loss is read in plain words before anything is placed.
  const [review, setReview] = useState(false);
  useEffect(() => setReview(false), [side, kind, units, price, useSl, useTp, sl, tp]);
  const q = state.price;
  const long = side === "long";

  // Entry the order would fill at: the current ask or bid for a market order, otherwise its own price.
  const entry = kind === "market" ? (q ? (long ? q.ask : q.bid) : null) : num(price);
  const u = Number(units) || 0;
  const slN = useSl ? num(sl) : null, tpN = useTp ? num(tp) : null;
  const risk = entry != null && slN != null ? Math.abs(entry - slN) * u : null;
  const reward = entry != null && tpN != null ? Math.abs(tpN - entry) * u : null;
  const riskPct = risk != null && state.account.equity > 0 ? (risk / state.account.equity) * 100 : null;
  const margin = entry != null ? u * entry * (state.settings.margin_rate_pct / 100) : null;
  const limit = profile?.max_risk_per_trade_pct ?? 1;
  const over = riskPct != null && riskPct > limit + 0.05;

  // Sensible starting values whenever the side, type or price changes.
  const base = q ? (long ? q.ask : q.bid) : null;
  useEffect(() => {
    if (base == null) return;
    const dir = long ? 1 : -1;
    // Distances scale with the price: about $5, $10 and $20 away for gold, the same share for other markets.
    const step = base * 0.002;
    const p = kind === "market" ? base : kind === "limit" ? base - dir * step : base + dir * step;
    if (kind !== "market") setPrice(p.toFixed(d));
    setSl((p - dir * step * 2).toFixed(d));
    setTp((p + dir * step * 4).toFixed(d));
    setError(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [side, kind, base == null, market.symbol]);

  function sizeByRisk() {
    if (entry == null || slN == null || entry === slN) return;
    const oz = (state.account.equity * limit) / 100 / Math.abs(entry - slN);
    setUnits(String(Math.max(Math.floor(oz * 100) / 100, 0.01)));
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (!review) {
      setReview(true);
      return;
    }
    setBusy(true);
    try {
      const body: PaperOrderInput = { symbol: market.symbol, side, kind, units: u, stop_loss: slN, take_profit: tpN, price: kind === "market" ? null : num(price) };
      const r = await api.paperOrder(body);
      const verb = long ? "Bought" : "Sold";
      setReview(false);
      if (r.position) {
        toast(`Filled: ${verb.toLowerCase()} ${u} ${ux(u)}${market.symbol !== GOLD.symbol ? ` ${market.name}` : ""}`, {
          tone: "fill",
          body: `At ${px(r.position.entry_price, d)}${slN != null ? `, stop at ${px(slN, d)}` : ", no stop set"}`,
        });
        await onPlaced(null);
      } else await onPlaced(`${long ? "Buy" : "Sell"} ${kind} order placed: ${u} ${ux(u)} at ${px(r.order?.price, d)}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't place the order");
    } finally {
      setBusy(false);
    }
  }

  const closedForMarket = kind === "market" && q && !q.open;
  return (
    <form onSubmit={submit} className="space-y-4 rounded-2xl border border-border bg-surface p-4">
      <div className="grid grid-cols-2 gap-2">
        {(["long", "short"] as const).map((s) => (
          <button key={s} type="button" onClick={() => setSide(s)} aria-pressed={side === s}
            className={`rounded-lg border px-3 py-2.5 text-left transition ${side === s
              ? s === "long" ? "border-up bg-up/15" : "border-down bg-down/15"
              : "border-border hover:border-muted"}`}>
            <span className={`flex items-center gap-1 text-sm font-semibold ${s === "long" ? "text-up" : "text-down"}`}>
              <Icon name={s === "long" ? "up" : "down"} className="h-3.5 w-3.5" strokeWidth={2.4} />{s === "long" ? "Buy" : "Sell"}
            </span>
            <span className="text-xs tabular-nums text-muted">{q ? px(s === "long" ? q.ask : q.bid, d) : "–"}</span>
          </button>
        ))}
      </div>

      <div>
        <Chips<Kind> value={kind} onChange={setKind} options={[
          { key: "market", label: "Market" }, { key: "limit", label: "Limit" }, { key: "stop", label: "Stop" },
        ]} />
        <p className="mt-1.5 text-xs text-muted">{KIND_HELP[kind]}</p>
      </div>

      {kind !== "market" && (
        <label className="block text-sm">
          <span className="text-muted">{kind === "limit" ? "Limit" : "Stop"} price</span>
          <input value={price} onChange={(e) => setPrice(e.target.value)} inputMode="decimal" className={`${input} mt-1`} />
        </label>
      )}

      <div>
        <label className="block text-sm">
          <span className="flex justify-between text-muted">Size in {market.unit === "MMBtu" ? "MMBtu" : `${market.unit}s`} <span className="text-xs tabular-nums">{u && market.lot > 1 ? `${(u / market.lot).toFixed(2)} lot` : ""}</span></span>
          <input value={units} onChange={(e) => setUnits(e.target.value)} inputMode="decimal" className={`${input} mt-1`} />
        </label>
        <div className="mt-2 flex flex-wrap gap-1.5">
          {sizes.map((s) => (
            <button key={s} type="button" onClick={() => setUnits(String(s))}
              className={`rounded-full border px-2.5 py-0.5 text-xs tabular-nums transition ${u === s ? "border-gold text-foreground" : "border-border text-muted hover:border-muted"}`}>
              {s.toLocaleString("en-US")} {ux(s)}
            </button>
          ))}
          {entry != null && state.account.free_margin > 0 && (
            <button type="button" title={`The most your free margin allows at 1:${state.settings.market_leverage ?? state.account.leverage}`}
              onClick={() => setUnits(String(Math.max(Math.floor((state.account.free_margin / (entry * state.settings.margin_rate_pct / 100)) * 100) / 100, 0.01)))}
              className="rounded-full border border-border px-2.5 py-0.5 text-xs text-muted transition hover:border-gold hover:text-foreground">
              Max
            </button>
          )}
        </div>
      </div>

      {(["sl", "tp"] as const).map((k) => {
        const on = k === "sl" ? useSl : useTp;
        return (
          <div key={k}>
            <label className="flex cursor-pointer items-center justify-between text-sm">
              <span className="text-muted">{k === "sl" ? "Stop loss" : "Take profit"}</span>
              <span className={`relative h-5 w-9 rounded-full transition-colors ${on ? "bg-gold" : "bg-border"}`}>
                <span className={`absolute top-0.5 h-4 w-4 rounded-full bg-foreground transition-all ${on ? "left-4.5" : "left-0.5"}`} />
              </span>
              <input type="checkbox" className="sr-only" checked={on} onChange={(e) => (k === "sl" ? setUseSl : setUseTp)(e.target.checked)} />
            </label>
            {on && (
              <input value={k === "sl" ? sl : tp} onChange={(e) => (k === "sl" ? setSl : setTp)(e.target.value)}
                     inputMode="decimal" className={`${input} quiz-in mt-1`} aria-label={k === "sl" ? "Stop loss price" : "Take profit price"} />
            )}
          </div>
        );
      })}

      <div className="space-y-1.5 rounded-lg bg-background p-3 text-xs">
        <div className="flex justify-between"><span className="text-muted">Margin needed at 1:{state.account.leverage}</span><span className="tabular-nums">{fmtUsd(margin)} of {fmtUsd(state.account.free_margin)} free</span></div>
        <div className="flex justify-between">
          <span className="text-muted">If the stop is hit</span>
          <span className={`tabular-nums ${over ? "text-down" : ""}`}>
            {risk != null ? `-${fmtUsd(risk)} (${riskPct!.toFixed(1)}% of equity)` : "No limit on the loss"}
          </span>
        </div>
        {reward != null && (
          <div className="flex justify-between">
            <span className="text-muted">If the target is hit</span>
            <span className="tabular-nums text-up">+{fmtUsd(reward)}{risk ? ` · ${(reward / risk).toFixed(1)} to 1` : ""}</span>
          </div>
        )}
        {riskPct != null && (
          <div className="pt-1">
            <div className="h-1.5 overflow-hidden rounded-full bg-border">
              <div className={`h-full rounded-full transition-all ${over ? "bg-down" : "bg-up"}`} style={{ width: `${Math.min(riskPct / (limit * 2), 1) * 100}%` }} />
            </div>
            <p className="mt-1 flex justify-between text-muted">
              <span>{profile ? `Your ${profile.label.toLowerCase()} limit: ${limit}% a trade` : `A common rule of thumb: ${limit}% a trade`}</span>
              {slN != null && <button type="button" onClick={sizeByRisk} className="text-gold hover:underline">Size to {limit}%</button>}
            </p>
          </div>
        )}
      </div>

      {error && <p className="text-sm text-down">{error}</p>}
      {closedForMarket && (
        <p className="text-xs text-muted">
          {q?.in_hours === false ? `${market.name} trades ${market.hours}. ` : "The market looks closed. "}
          Market orders are paused until it opens; limit and stop orders still work.
        </p>
      )}
      {review ? (
        <div className="rise-in space-y-3 rounded-2xl border border-calm/30 bg-calm/5 p-4 text-sm">
          <p className="font-medium">Before you place it</p>
          <p className="leading-relaxed text-muted">
            You&apos;re {long ? "buying" : "selling"} <span className="text-foreground">{u} {ux(u)}</span> of {market.symbol === GOLD.symbol ? "gold" : market.name}
            {kind === "market" ? <> at about <span className="text-foreground">{px(entry, d)}</span></> : <> if the price reaches <span className="text-foreground">{px(num(price), d)}</span></>}.
          </p>
          <ul className="space-y-1.5">
            <Check ok={slN != null}>
              {slN != null && risk != null
                ? <>If {market.symbol === GOLD.symbol ? "gold" : market.name} {long ? "falls" : "rises"} to {px(slN, d)}, the most you lose is {fmtUsd(risk)} ({riskPct!.toFixed(1)}% of your account).</>
                : <>There&apos;s no stop loss, so the loss isn&apos;t limited.</>}
            </Check>
            {riskPct != null && (
              <Check ok={!over}>
                {over
                  ? <>That&apos;s {(riskPct / limit).toFixed(1)} times your {limit}% limit. <button type="button" onClick={sizeByRisk} className="text-gold hover:underline">Size it to {limit}%</button></>
                  : <>That&apos;s within your {limit}% limit for one trade.</>}
              </Check>
            )}
            {reward != null && risk != null && risk > 0 && (
              <Check ok={reward >= risk}>The target would make {(reward / risk).toFixed(1)} times what the stop would lose.</Check>
            )}
          </ul>
          <p className="text-xs text-muted">Virtual money only. You can change anything, or simply not place it.</p>
          <div className="grid grid-cols-2 gap-2">
            <button type="button" onClick={() => setReview(false)} className="rounded-full border border-border py-2.5 text-sm transition-colors hover:bg-surface-2">
              Change it
            </button>
            <button disabled={busy || !u || !!closedForMarket}
              className={`rounded-full py-2.5 text-sm font-semibold text-black transition-opacity hover:opacity-90 disabled:opacity-50 ${long ? "bg-up" : "bg-down"}`}>
              {busy ? "Placing…" : `Place ${long ? "buy" : "sell"}`}
            </button>
          </div>
        </div>
      ) : (
        <button disabled={busy || !u || !!closedForMarket}
          className="w-full rounded-full border border-border bg-surface-2 py-2.5 text-sm font-medium transition-colors hover:border-gold/60 disabled:opacity-50">
          Review {long ? "buy" : "sell"} of {u || ""} {ux(u)} {kind === "market" ? "at market" : `${kind} at ${px(num(price), d)}`}
        </button>
      )}
    </form>
  );
}

function Check({ ok, children }: { ok: boolean; children: React.ReactNode }) {
  return (
    <li className="flex gap-2">
      <span className={`mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded-full ${ok ? "bg-up/20 text-up" : "bg-gold/20 text-gold"}`}>
        {ok ? <Icon name="check" className="h-3 w-3" strokeWidth={2.6} /> : <span className="text-[10px] font-bold">!</span>}
      </span>
      <span>{children}</span>
    </li>
  );
}

/** Leverage, adding or taking out virtual money, and starting over. */
function Settings({ state, busy, act, onClose }: {
  state: PaperState;
  busy: boolean;
  act: (fn: () => Promise<unknown>, done?: string) => Promise<boolean>;
  onClose: () => void;
}) {
  const a = state.account, st = state.settings;
  const [amount, setAmount] = useState("10000");
  const [balance, setBalance] = useState(String(a.starting_balance));
  const [lev, setLev] = useState(a.leverage);
  const [custom, setCustom] = useState("");
  const [confirm, setConfirm] = useState(false);
  const amt = Number(amount) || 0, bal = Number(balance) || 0;
  const levBtn = (l: number, on: boolean, click: () => void) => (
    <button key={l} type="button" disabled={busy} onClick={click} aria-pressed={on}
      className={`rounded-full border px-2.5 py-1 text-xs tabular-nums transition disabled:opacity-50 ${on ? "border-gold bg-gold/15 text-foreground" : "border-border text-muted hover:border-muted hover:text-foreground"}`}>
      1:{l}
    </button>
  );
  return (
    <div id="account-settings" className="quiz-in mt-6 grid scroll-mt-24 gap-5 rounded-2xl border border-gold/30 bg-surface p-4 lg:grid-cols-[1.5fr_1fr_1fr]">
      <section>
        <h3 className="flex items-center gap-2 text-sm font-medium"><Icon name="layers" className="h-4 w-4 text-gold" />Leverage</h3>
        <p className="mt-1 text-xs text-muted">Applies to open positions too, as it does at a broker.</p>
        <div className="mt-3">
          <LeveragePicker value={a.leverage} disabled={busy} balance={a.equity} price={state.price?.bid ?? 2000}
            stopOut={st.stop_out_pct} marginCall={st.margin_call_pct}
            onPick={(l) => act(() => api.paperLeverage(l), `Leverage set to 1:${l}`)} />
        </div>
        <form className="mt-2 flex gap-2" onSubmit={(e) => {
          e.preventDefault();
          const l = Math.round(Number(custom));
          if (l >= 1) act(() => api.paperLeverage(l), `Leverage set to 1:${l}`).then((ok) => ok && setCustom(""));
        }}>
          <input value={custom} onChange={(e) => setCustom(e.target.value)} inputMode="numeric" placeholder={`Other, up to ${st.max_leverage}`} className={`${input} w-44`} aria-label="Other leverage" />
          <button disabled={busy || !custom} className="rounded-lg border border-border px-3 text-xs transition hover:border-gold disabled:opacity-50">Set</button>
        </form>
      </section>

      <section>
        <h3 className="flex items-center gap-2 text-sm font-medium"><Icon name="wallet" className="h-4 w-4 text-gold" />Add or take out money</h3>
        <p className="mt-1 text-xs text-muted">It&apos;s virtual, so add as much as you like, up to {short(st.max_balance)}. Deposits count toward what you started with, so your return stays honest.</p>
        <input value={amount} onChange={(e) => setAmount(e.target.value)} inputMode="decimal" className={`${input} mt-3`} aria-label="Amount in dollars" />
        <div className="mt-2 flex flex-wrap gap-1.5">
          {[1_000, 10_000, 100_000, 1_000_000].map((v) => (
            <button key={v} type="button" onClick={() => setAmount(String(v))}
              className={`rounded-full border px-2.5 py-0.5 text-xs tabular-nums transition ${amt === v ? "border-gold text-foreground" : "border-border text-muted hover:border-muted"}`}>{short(v)}</button>
          ))}
        </div>
        <div className="mt-3 grid grid-cols-2 gap-2">
          <button disabled={busy || amt <= 0} onClick={() => act(() => api.paperFunds(amt), `Added ${fmtUsd(amt)}`)}
            className="rounded-lg bg-up py-2 text-sm font-medium text-black disabled:opacity-50">Add</button>
          <button disabled={busy || amt <= 0} onClick={() => act(() => api.paperFunds(-amt), `Took out ${fmtUsd(amt)}`)}
            className="rounded-lg border border-border py-2 text-sm transition hover:border-muted disabled:opacity-50">Take out</button>
        </div>
      </section>

      <section>
        <h3 className="flex items-center gap-2 text-sm font-medium"><Icon name="clock" className="h-4 w-4 text-gold" />Start over</h3>
        <p className="mt-1 text-xs text-muted">A fresh account with any balance and leverage. This deletes every paper position, order and result.</p>
        <input value={balance} onChange={(e) => { setBalance(e.target.value); setConfirm(false); }} inputMode="decimal" className={`${input} mt-3`} aria-label="Starting balance in dollars" />
        <div className="mt-2 flex flex-wrap gap-1.5">
          {BALANCES.map((v) => (
            <button key={v} type="button" onClick={() => { setBalance(String(v)); setConfirm(false); }}
              className={`rounded-full border px-2.5 py-0.5 text-xs tabular-nums transition ${bal === v ? "border-gold text-foreground" : "border-border text-muted hover:border-muted"}`}>{short(v)}</button>
          ))}
        </div>
        <div className="mt-2 flex flex-wrap gap-1.5">
          {st.leverages.filter((l) => [1, 10, 30, 100, 500].includes(l)).map((l) => levBtn(l, lev === l, () => { setLev(l); setConfirm(false); }))}
        </div>
        {confirm ? (
          <div className="quiz-in mt-3 grid grid-cols-2 gap-2">
            <button disabled={busy} onClick={async () => { if (await act(() => api.paperReset(bal, lev), `New account: ${fmtUsd(bal)} at 1:${lev}`)) onClose(); }}
              className="rounded-lg bg-down py-2 text-sm font-medium text-black disabled:opacity-50">Yes, start over</button>
            <button onClick={() => setConfirm(false)} className="rounded-lg border border-border py-2 text-sm">Keep my account</button>
          </div>
        ) : (
          <button disabled={busy || bal < 1 || bal > st.max_balance} onClick={() => setConfirm(true)}
            className="mt-3 w-full rounded-lg border border-border py-2 text-sm transition hover:border-gold disabled:opacity-50">
            Start over with {bal >= 1 ? short(bal) : "…"} at 1:{lev}
          </button>
        )}
      </section>
    </div>
  );
}

export default function PaperPage() {
  const { user } = useUser();
  const [market, setSymbol, markets] = useMarket();
  const symbol = market.symbol;
  const marketOf = useCallback((s?: string | null) => markets.find((m) => m.symbol === (s ?? GOLD.symbol)) ?? (s === market.symbol ? market : GOLD), [markets, market]);
  const [state, setState] = useState<PaperState | null>(null);
  const [report, setReport] = useState<Report | null>(null);
  const [profile, setProfile] = useState<RiskProfile | null>(null);
  const [tab, setTab] = useState<Tab>("positions");
  const [busy, setBusy] = useState(false);
  const [resetOpen, setResetOpen] = useState(false);
  const [preset, setPreset] = useState<{ oz: number; n: number } | null>(null);
  const [setupDone, setSetupDone] = useState(true);
  useEffect(() => {
    try { setSetupDone(!!localStorage.getItem(SETUP_KEY)); } catch {}
  }, []);
  const [error, setError] = useState<string | null>(null);
  const [grades, setGrades] = useState<Record<string, "A" | "B" | "C" | "D">>({});
  const seen = useRef<Set<number> | null>(null);
  const openIds = useRef<Set<number> | null>(null);

  const say = useCallback((msg: string, t: "up" | "down" | "info" = "info") => toast(msg, { tone: t }), []);

  const load = useCallback(async () => {
    const s = await api.paper(symbol);
    // Tell the user about positions the server closed (stop, target or stop-out) since the last look.
    if (seen.current) {
      for (const h of s.history)
        if (!seen.current.has(h.id) && h.close_reason !== "manual")
          say(`${REASON[h.close_reason ?? ""]}: ${signed(h.pnl)}`, (h.pnl ?? 0) >= 0 ? "up" : "down");
    }
    seen.current = new Set(s.history.map((h) => h.id));
    // A limit or stop order that filled since the last look gets the same confirmation as a market fill.
    if (openIds.current) {
      for (const p of s.positions)
        if (!openIds.current.has(p.id) && (p.order_kind === "limit" || p.order_kind === "stop"))
          toast(`Your ${p.order_kind} order filled`, { tone: "fill", body: `${p.side === "long" ? "Long" : "Short"} ${p.units} ${unitShort(marketOf(p.symbol), p.units)} of ${marketOf(p.symbol).name} at ${px(p.entry_price, marketOf(p.symbol).decimals)}` });
    }
    openIds.current = new Set(s.positions.map((p) => p.id));
    setState(s.symbol && s.symbol !== symbol ? null : s);
    return s;
  }, [say, symbol, marketOf]);

  useEffect(() => {
    if (!user) return;
    load().catch((e) => setError(e instanceof Error ? e.message : "Couldn't load your account"));
    api.riskProfile().then(setProfile, () => {});
    const id = setInterval(() => {
      if (document.visibilityState === "visible") load().catch(() => {});
    }, POLL_MS);
    return () => clearInterval(id);
  }, [user, load]);

  const closedCount = state?.account.closed_trades ?? 0;
  useEffect(() => {
    if (user && tab === "history") api.reviewGrades().then(setGrades, () => {});
  }, [user, tab]);
  useEffect(() => {
    if (user && tab === "report") api.paperReport().then(setReport, () => {});
  }, [user, tab, closedCount]);

  if (user === null) return <SignInPrompt what="practise trading with virtual money" next="/paper" />;
  if (user === undefined) return null;

  async function act(fn: () => Promise<unknown>, done?: string) {
    setBusy(true);
    try {
      await fn();
      await load();
      if (done) say(done);
      return true;
    } catch (e) {
      say(e instanceof Error ? e.message : "Something went wrong", "down");
      return false;
    } finally {
      setBusy(false);
    }
  }

  // Trading from the chart: the same actions as the ticket and the position list.
  const chartActions: TradeActions = {
    protect: (id, sl, tp) => act(() => api.paperProtect(id, sl, tp), "Stop and target moved"),
    modify: (id, body) => act(() => api.paperModify(id, body), "Order moved"),
    cancel: (id) => act(() => api.paperCancel(id), "Order cancelled"),
    close: (id) => act(() => api.paperClose(id), "Position closed"),
    place: async (o) => {
      let filled: PaperPosition | undefined, waiting: PaperOrder | undefined;
      const d = market.decimals, u = `${unitShort(market, o.units)} of ${market.name}`;
      const ok = await act(async () => { const r = await api.paperOrder({ ...o, symbol }); filled = r.position; waiting = r.order; });
      if (filled) toast(`Filled: ${o.side === "long" ? "bought" : "sold"} ${o.units} ${u}`, {
        tone: "fill", body: `At ${px(filled.entry_price, d)}${o.stop_loss != null ? `, stop at ${px(o.stop_loss, d)}` : ", no stop set"}`,
      });
      else if (waiting) say(`${o.side === "long" ? "Buy" : "Sell"} ${o.kind} order placed: ${o.units} ${u} at ${px(waiting.price, d)}`, "up");
      if (ok) setTab((t) => (t === "report" || t === "history" ? (filled ? "positions" : "orders") : t));
      return ok;
    },
  };

  const a = state?.account;
  const level = a?.margin_level_pct;
  // The chart shows the market being traded, so it only draws that market's positions and orders.
  const here = <T extends { symbol?: string | null }>(xs: T[]) => xs.filter((x) => (x.symbol ?? GOLD.symbol) === symbol);
  const st = state?.settings;
  const swapText = (v: number | null | undefined, pct: number) => v != null ? `${v > 0 ? "+" : ""}${v.toFixed(2)} per ${market.unit}` : `${pct > 0 ? "+" : ""}${pct}% a year of the position's value`;
  return (
    <div className="mx-auto max-w-6xl px-4 py-8">
      <PageHeader icon="wallet" title="Paper trading"
        subtitle="Practise trading gold, currencies, indices, stocks and crypto with virtual money on real prices. Orders fill at the real bid and ask, with spread and overnight swap, but no real money or broker is involved."
        right={
          <div className="flex flex-wrap items-center gap-2">
            <MarketPicker market={market} markets={markets} onChange={setSymbol} />
            <Link href="/paper/agent" className="flex items-center gap-1.5 rounded-lg border border-gold/60 px-3 py-1.5 text-sm text-gold transition hover:bg-gold/10">
              <Icon name="assistant" className="h-4 w-4" />Strategy agent
            </Link>
            {state && (
              <button onClick={() => setResetOpen(true)} className="rounded-full border border-gold/40 bg-gold/10 px-2.5 py-1 text-xs tabular-nums text-gold transition hover:bg-gold/20">
                Leverage 1:{state.account.leverage}
              </button>
            )}
            <button onClick={() => setResetOpen(!resetOpen)} aria-expanded={resetOpen}
              className={`rounded-lg border px-3 py-1.5 text-sm transition ${resetOpen ? "border-gold" : "border-border hover:border-muted"}`}>
              {resetOpen ? "Done" : "Account settings"}
            </button>
          </div>
        } />

      {state && !setupDone && !resetOpen && state.account.closed_trades === 0 && !state.positions.length && !state.orders.length && (
        <AccountSetup state={state} onDone={async (m) => { setSetupDone(true); if (m) { await load(); toast(m, { tone: "fill" }); } }} />
      )}
      {state?.account.margin_call && (
        <div role="alert" className="rise-in mt-6 flex flex-wrap items-center gap-3 rounded-2xl border border-down/50 bg-down/10 p-4">
          <span className="breathe h-2.5 w-2.5 rounded-full bg-down" />
          <p className="min-w-0 flex-1 text-sm">
            <b className="text-down">Margin call.</b> Your equity is below the margin your positions use
            ({state.account.margin_level_pct?.toFixed(0)}% margin level). New trades are blocked, and at {state.settings.stop_out_pct}% your
            positions close automatically. Close or shrink a position, add funds, or raise leverage.
          </p>
          <button onClick={() => setResetOpen(true)} className="rounded-full border border-down/50 px-3 py-1.5 text-sm">Account settings</button>
        </div>
      )}
      {state && resetOpen && <Settings state={state} busy={busy} act={act} onClose={() => setResetOpen(false)} />}
      {error && !state && <p className="mt-6 text-sm text-down">{error}</p>}
      {!state && !error && <div className="mt-6 h-40 animate-pulse rounded-2xl bg-surface" />}

      {state && a && (
        <>
          <div className="mt-6 grid grid-cols-2 gap-3 lg:grid-cols-[1.4fr_1fr_1fr_1fr]">
            <div className="col-span-2 rounded-2xl border border-gold/40 bg-gradient-to-br from-gold/15 to-transparent p-3.5 lg:col-span-1">
              <p className="flex items-center gap-1.5 text-xs text-gold"><Icon name="wallet" className="h-3.5 w-3.5" />Account value (equity)
                <button type="button" onClick={() => { setResetOpen(true); setTimeout(() => document.getElementById("account-settings")?.scrollIntoView({ behavior: "smooth", block: "start" }), 50); }}
                  className="ml-auto rounded-full border border-gold/40 px-2 py-0.5 text-[11px] text-gold transition hover:bg-gold/15">Edit balance</button>
              </p>
              <p className="mt-1 text-2xl font-semibold tabular-nums"><CountUp value={a.equity} format={(v) => fmtUsd(v)} /></p>
              <p className={`text-xs tabular-nums ${tone(a.return_pct)}`}>
                {a.return_pct > 0 ? "+" : ""}{a.return_pct.toFixed(2)}% since you started with {fmtUsd(a.starting_balance)}
              </p>
            </div>
            <Stat icon="bolt" label="Open profit / loss" hint={`${state.positions.length} open position${state.positions.length === 1 ? "" : "s"}`}>
              <span className={tone(a.unrealized)}>{signed(a.unrealized)}</span>
            </Stat>
            <Stat icon="trophy" label="Closed trades" hint={a.closed_trades ? `${a.wins} won · ${signed(a.realized)} in total` : "None yet"}>
              {a.closed_trades ? `${Math.round((a.wins / a.closed_trades) * 100)}% won` : "–"}
            </Stat>
            <Stat icon="scale" label="Free margin"
              hint={level != null ? (
                <span className="block">
                  <span className="relative mt-1 block h-1.5 overflow-hidden rounded-full bg-border">
                    <span className={`block h-full rounded-full transition-all ${level < 150 ? "bg-down" : level < 400 ? "bg-gold" : "bg-up"}`}
                          style={{ width: `${Math.min(level / 10, 100)}%` }} />
                    <span aria-hidden className="absolute inset-y-0 w-px bg-down" style={{ left: `${state.settings.stop_out_pct / 10}%` }} />
                    <span aria-hidden className="absolute inset-y-0 w-px bg-gold" style={{ left: `${(state.settings.margin_call_pct ?? 100) / 10}%` }} />
                  </span>
                  <span className="mt-1 block">Margin level {level.toFixed(0)}% · call at {state.settings.margin_call_pct ?? 100}% · stop-out at {state.settings.stop_out_pct}%</span>
                </span>
              ) : `Leverage 1:${a.leverage}`}>
              {fmtUsd(a.free_margin)}
            </Stat>
          </div>

          <div className="mt-6 grid grid-cols-1 gap-6 lg:grid-cols-[minmax(0,1fr)_340px]">
            <div className="min-w-0 space-y-4">
              <div className="rounded-2xl border border-border bg-surface p-4"><Quote price={state.price} market={market} /></div>
              <PriceChart height={400} initialTf="1m" tools market={market} overlay={({ chart, series, below }) => (
                <TradeLines chart={chart} series={series} below={below} positions={here(state.positions)} orders={here(state.orders)} price={state.price} market={market}
                  equity={a.equity} riskLimit={profile?.max_risk_per_trade_pct ?? 1} busy={busy} actions={chartActions} />
              )} />
              <p className="-mt-2 text-xs text-muted">
                Trade from the chart: use its Buy and Sell buttons, or right-click a price (press and hold on a phone) for a limit or stop
                order there. Drag the dashed lines to move an order, its stop loss or its take profit; ✕ closes or cancels.
              </p>

              <Chips<Tab> value={tab} onChange={setTab} options={[
                { key: "positions", label: "Open positions", count: state.positions.length },
                { key: "orders", label: "Pending orders", count: state.orders.length },
                { key: "history", label: "History", count: a.closed_trades },
                { key: "report", label: "Report" },
                { key: "habits", label: "Habits" },
              ]} />

              {tab === "habits" && <Insights source="paper" refresh={a.closed_trades} />}

              {tab === "positions" && (
                <div className="space-y-3">
                  {state.positions.length === 0 && (
                    <Empty icon="wallet" title="No open positions">Use the order ticket or the chart to buy or sell. Try a small size with a stop loss first.</Empty>
                  )}
                  {state.positions.map((p) => (
                    <PositionRow key={p.id} p={p} m={marketOf(p.symbol)} busy={busy}
                      onClose={() => act(() => api.paperClose(p.id), "Position closed")}
                      onSave={(sl, tp) => act(() => api.paperProtect(p.id, sl, tp), "Stop and target saved")} />
                  ))}
                </div>
              )}

              {tab === "orders" && (
                <div className="space-y-3">
                  {state.orders.length === 0 && <Empty icon="clock" title="No pending orders">Limit and stop orders wait here until the price reaches them.</Empty>}
                  {state.orders.map((o) => (
                    <OrderRow key={o.id} o={o} m={marketOf(o.symbol)} price={state.price} busy={busy} onCancel={() => act(() => api.paperCancel(o.id), "Order cancelled")} />
                  ))}
                  {state.cancelled_orders.filter((o) => o.note && o.note !== "Cancelled by you").slice(0, 3).map((o) => (
                    <p key={o.id} className="text-xs text-muted">
                      {o.side === "long" ? "Buy" : "Sell"} {marketOf(o.symbol).name} {o.kind} at {px(o.price, marketOf(o.symbol).decimals)} was cancelled: {o.note.toLowerCase()}.
                    </p>
                  ))}
                </div>
              )}

              {tab === "history" && (
                <div className="space-y-2">
                  {state.history.length === 0 && <Empty icon="trades" title="No closed trades yet" />}
                  {state.history.map((h, i) => (
                    <div key={h.id} className="rise-in flex flex-wrap items-center gap-x-4 gap-y-1 rounded-lg border border-border bg-surface px-3.5 py-2.5 text-sm"
                         style={{ animationDelay: `${Math.min(i, 10) * 25}ms` }}>
                      <SidePill side={h.side} />
                      <span className="tabular-nums">{h.units} {unitShort(marketOf(h.symbol), h.units)}{(h.symbol ?? GOLD.symbol) !== GOLD.symbol && ` ${marketOf(h.symbol).name}`}</span>
                      <span className="text-xs text-muted tabular-nums">{px(h.entry_price, marketOf(h.symbol).decimals)} → {px(h.exit_price, marketOf(h.symbol).decimals)}</span>
                      <span className="rounded-full bg-border px-2 py-0.5 text-[11px] text-muted">{REASON[h.close_reason ?? ""]}</span>
                      <span className="text-xs text-muted">{h.closed_at && when(h.closed_at)}</span>
                      <span className={`ml-auto font-medium tabular-nums ${tone(h.pnl)}`}>{signed(h.pnl)}</span>
                      <TradeReview id={h.id} grade={grades[String(h.id)]} onGraded={(g) => setGrades((m) => ({ ...m, [String(h.id)]: g }))} />
                    </div>
                  ))}
                </div>
              )}

              {tab === "report" && (
                <div className="space-y-4">
                  {report ? <ReportView report={report} kind="paper" /> : <div className="h-32 animate-pulse rounded-2xl bg-surface" />}
                  {report && report.stats.trades > 0 && <FitPanel load={api.paperFit} deps={[closedCount]} />}
                </div>
              )}
            </div>

            <aside className="order-first space-y-3 lg:sticky lg:top-20 lg:order-none lg:self-start">
              <h2 className="flex items-center gap-2 font-medium"><Icon name="bolt" className="h-4 w-4 text-gold" />New order</h2>
              <Ticket state={state} market={market} profile={profile} busy={busy} setBusy={setBusy} preset={preset}
                onPlaced={async (msg) => { await load(); setTab((t) => (t === "report" || t === "history" ? "positions" : t)); if (msg) say(msg, "up"); }} />
              <p className="text-xs leading-relaxed text-muted">
                {market.name}: spread {st!.spread.toFixed(market.decimals)} per {market.unit}. Overnight swap {swapText(st!.swap_long, market.swap_long_pct)} long
                and {swapText(st!.swap_short, market.swap_short_pct)} short.
                {st!.market_max_leverage && st!.market_max_leverage < a.leverage ? ` Leverage on ${market.name} is capped at 1:${st!.market_max_leverage}.` : ""}{" "}
                Trading hours: {market.hours}. Stops and targets are checked against every minute of real prices,
                even while this page is closed. Practice only, not advice.
              </p>
              <SizeCalculator equity={a.equity} leverage={a.leverage} price={state.price?.ask ?? null}
                riskPct={profile?.max_risk_per_trade_pct ?? 1} onUse={(oz) => setPreset((p) => ({ oz, n: (p?.n ?? 0) + 1 }))} />
              {symbol === GOLD.symbol && <AlertsCard price={state.price?.bid ?? null} />}
              <div className="grid grid-cols-2 gap-2 text-sm">
                <Link href="/paper/replay" className="card flex items-center gap-2 p-3 hover:border-gold/40"><Icon name="clock" className="h-4 w-4 text-gold" />Replay a day</Link>
                <Link href="/paper/challenge" className="card flex items-center gap-2 p-3 hover:border-gold/40"><Icon name="trophy" className="h-4 w-4 text-gold" />Weekly challenge</Link>
              </div>
            </aside>
          </div>
        </>
      )}

    </div>
  );
}
