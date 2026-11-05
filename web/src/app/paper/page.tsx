"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import FitPanel from "@/components/FitPanel";
import PriceChart from "@/components/PriceChart";
import ReportView from "@/components/ReportView";
import SignInPrompt from "@/components/SignInPrompt";
import { Chips, CountUp, Empty, Icon, PageHeader, SidePill } from "@/components/ui";
import {
  api, fmtUsd, type PaperOrder, type PaperOrderInput, type PaperPosition, type PaperState, type Report, type RiskProfile,
} from "@/lib/api";
import { useUser } from "@/lib/useUser";

type Side = "long" | "short";
type Kind = "market" | "limit" | "stop";
type Tab = "positions" | "orders" | "history" | "report";

const POLL_MS = 5000;
const SIZES = [1, 5, 10, 50, 100];
const BALANCES = [1_000, 10_000, 50_000, 100_000];
const REASON: Record<string, string> = {
  manual: "Closed by you",
  stop_loss: "Stop loss hit",
  take_profit: "Take profit hit",
  stop_out: "Margin stop-out",
};
const KIND_HELP: Record<Kind, string> = {
  market: "Fills now at the current price.",
  limit: "Waits for a better price: a buy below the ask, a sell above the bid.",
  stop: "Waits for the price to break through: a buy above the ask, a sell below the bid.",
};

const input = "w-full rounded-md border border-border bg-background px-3 py-2 text-base tabular-nums outline-none transition focus:border-gold sm:text-sm";
const px = (v: number | null | undefined) => (v == null ? "–" : v.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 }));
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
function Quote({ price }: { price: PaperState["price"] }) {
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
        <p className={`text-xl font-semibold tabular-nums transition-colors ${cls}`}>{px(price.bid)}</p>
      </div>
      <div>
        <p className="text-[11px] uppercase tracking-wide text-muted">Buy at (ask)</p>
        <p className={`text-xl font-semibold tabular-nums transition-colors ${cls}`}>{px(price.ask)}</p>
      </div>
      <span className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs ${price.open ? "bg-up/15 text-up" : "bg-border text-muted"}`}>
        <span className={`h-1.5 w-1.5 rounded-full ${price.open ? "animate-pulse bg-up" : "bg-muted"}`} />
        {price.open ? (price.source === "live" ? "Live" : `Updated ${ago(price.age_seconds)}`) : `Market closed · last price ${ago(price.age_seconds)}`}
      </span>
    </div>
  );
}

function Stat({ label, children, hint, icon }: { label: string; children: React.ReactNode; hint?: React.ReactNode; icon: string }) {
  return (
    <div className="rounded-xl border border-border bg-surface p-3.5">
      <p className="flex items-center gap-1.5 text-xs text-muted"><Icon name={icon} className="h-3.5 w-3.5" />{label}</p>
      <p className="mt-1 text-lg font-semibold tabular-nums">{children}</p>
      {hint && <p className="mt-0.5 text-xs text-muted">{hint}</p>}
    </div>
  );
}

/** Where the price sits between the stop loss and the take profit. */
function Track({ p }: { p: PaperPosition }) {
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
        <span className="absolute top-1/2 h-2.5 w-2.5 -translate-x-1/2 -translate-y-1/2 rounded-full bg-gold shadow-[0_0_8px_var(--gold)] transition-all"
              style={{ left: `${mark}%` }} />
      </div>
      <div className="mt-1 flex justify-between text-[10px] tabular-nums text-muted">
        <span>{p.stop_loss != null ? `SL ${px(p.stop_loss)}` : ""}</span>
        <span>{p.take_profit != null ? `TP ${px(p.take_profit)}` : ""}</span>
      </div>
      {!long && <span className="sr-only">Short position</span>}
    </div>
  );
}

function PositionRow({ p, onClose, onSave, busy }: {
  p: PaperPosition;
  onClose: () => void;
  onSave: (sl: number | null, tp: number | null) => Promise<boolean>;
  busy: boolean;
}) {
  const [edit, setEdit] = useState(false);
  const [sl, setSl] = useState(p.stop_loss?.toString() ?? "");
  const [tp, setTp] = useState(p.take_profit?.toString() ?? "");
  return (
    <div className="rise-in rounded-xl border border-border bg-surface p-3.5">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <SidePill side={p.side} />
        <span className="text-sm tabular-nums">{p.units} oz</span>
        <span className="text-xs text-muted tabular-nums">from {px(p.entry_price)} → now {px(p.mark)}</span>
        <span className={`ml-auto text-lg font-semibold tabular-nums ${tone(p.pnl)}`}>{signed(p.pnl)}</span>
      </div>
      <div className="mt-3 flex flex-wrap items-center gap-3">
        <Track p={p} />
        <span className="text-xs text-muted">Opened {when(p.opened_at)}{p.order_kind !== "market" && ` · ${p.order_kind} order`}</span>
        <div className="ml-auto flex gap-2">
          <button onClick={() => setEdit(!edit)} className="rounded-md border border-border px-3 py-1.5 text-xs transition hover:border-muted">
            {edit ? "Cancel" : "Edit stop / target"}
          </button>
          <button onClick={onClose} disabled={busy} className="rounded-md bg-foreground px-3 py-1.5 text-xs font-medium text-background transition hover:opacity-90 disabled:opacity-50">
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
          <button disabled={busy} className="rounded-md bg-gold px-3 py-2 text-xs font-medium text-black disabled:opacity-50">Save</button>
        </form>
      )}
    </div>
  );
}

function OrderRow({ o, price, onCancel, busy }: { o: PaperOrder; price: PaperState["price"]; onCancel: () => void; busy: boolean }) {
  const ref = price ? (o.side === "long" ? price.ask : price.bid) : null;
  const gap = ref != null ? o.price - ref : null;
  return (
    <div className="rise-in flex flex-wrap items-center gap-x-4 gap-y-2 rounded-xl border border-dashed border-border bg-surface/60 p-3.5">
      <SidePill side={o.side} />
      <span className="rounded-full bg-border px-2 py-0.5 text-[11px] capitalize">{o.kind}</span>
      <span className="text-sm tabular-nums">{o.units} oz at {px(o.price)}</span>
      {gap != null && <span className="text-xs text-muted tabular-nums">{Math.abs(gap).toFixed(2)} {gap > 0 ? "above" : "below"} now</span>}
      <span className="text-xs text-muted tabular-nums">
        {o.stop_loss != null && `SL ${px(o.stop_loss)} `}{o.take_profit != null && `TP ${px(o.take_profit)}`}
      </span>
      <button onClick={onCancel} disabled={busy} className="ml-auto rounded-md border border-border px-3 py-1.5 text-xs transition hover:border-down hover:text-down disabled:opacity-50">
        Cancel
      </button>
    </div>
  );
}

function Ticket({ state, profile, onPlaced, busy, setBusy }: {
  state: PaperState;
  profile: RiskProfile | null;
  onPlaced: (msg: string) => Promise<void>;
  busy: boolean;
  setBusy: (b: boolean) => void;
}) {
  const [side, setSide] = useState<Side>("long");
  const [kind, setKind] = useState<Kind>("market");
  const [units, setUnits] = useState("10");
  const [price, setPrice] = useState("");
  const [useSl, setUseSl] = useState(true);
  const [useTp, setUseTp] = useState(false);
  const [sl, setSl] = useState("");
  const [tp, setTp] = useState("");
  const [error, setError] = useState<string | null>(null);
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
    const p = kind === "market" ? base : kind === "limit" ? base - dir * 5 : base + dir * 5;
    if (kind !== "market") setPrice(p.toFixed(2));
    setSl((p - dir * 10).toFixed(2));
    setTp((p + dir * 20).toFixed(2));
    setError(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [side, kind, base == null]);

  function sizeByRisk() {
    if (entry == null || slN == null || entry === slN) return;
    const oz = (state.account.equity * limit) / 100 / Math.abs(entry - slN);
    setUnits(String(Math.max(Math.floor(oz * 100) / 100, 0.01)));
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      const body: PaperOrderInput = { side, kind, units: u, stop_loss: slN, take_profit: tpN, price: kind === "market" ? null : num(price) };
      const r = await api.paperOrder(body);
      const verb = long ? "Bought" : "Sold";
      await onPlaced(r.position
        ? `${verb} ${u} oz at ${px(r.position.entry_price)}`
        : `${long ? "Buy" : "Sell"} ${kind} order placed: ${u} oz at ${px(r.order?.price)}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't place the order");
    } finally {
      setBusy(false);
    }
  }

  const closedForMarket = kind === "market" && q && !q.open;
  return (
    <form onSubmit={submit} className="space-y-4 rounded-xl border border-border bg-surface p-4">
      <div className="grid grid-cols-2 gap-2">
        {(["long", "short"] as const).map((s) => (
          <button key={s} type="button" onClick={() => setSide(s)} aria-pressed={side === s}
            className={`rounded-lg border px-3 py-2.5 text-left transition ${side === s
              ? s === "long" ? "border-up bg-up/15" : "border-down bg-down/15"
              : "border-border hover:border-muted"}`}>
            <span className={`flex items-center gap-1 text-sm font-semibold ${s === "long" ? "text-up" : "text-down"}`}>
              <Icon name={s === "long" ? "up" : "down"} className="h-3.5 w-3.5" strokeWidth={2.4} />{s === "long" ? "Buy" : "Sell"}
            </span>
            <span className="text-xs tabular-nums text-muted">{q ? px(s === "long" ? q.ask : q.bid) : "–"}</span>
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
          <span className="flex justify-between text-muted">Size in ounces <span className="text-xs tabular-nums">{u ? `${(u / 100).toFixed(2)} lot` : ""}</span></span>
          <input value={units} onChange={(e) => setUnits(e.target.value)} inputMode="decimal" className={`${input} mt-1`} />
        </label>
        <div className="mt-2 flex flex-wrap gap-1.5">
          {SIZES.map((s) => (
            <button key={s} type="button" onClick={() => setUnits(String(s))}
              className={`rounded-full border px-2.5 py-0.5 text-xs tabular-nums transition ${u === s ? "border-gold text-foreground" : "border-border text-muted hover:border-muted"}`}>
              {s} oz
            </button>
          ))}
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
        <div className="flex justify-between"><span className="text-muted">Margin needed</span><span className="tabular-nums">{fmtUsd(margin)} of {fmtUsd(state.account.free_margin)} free</span></div>
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
      {closedForMarket && <p className="text-xs text-muted">The market looks closed, so market orders are paused. Limit and stop orders still work.</p>}
      <button disabled={busy || !u || !!closedForMarket}
        className={`w-full rounded-lg py-2.5 text-sm font-semibold text-black transition hover:-translate-y-0.5 disabled:translate-y-0 disabled:opacity-50 ${long ? "bg-up" : "bg-down"}`}>
        {long ? "Buy" : "Sell"} {u || ""} oz {kind === "market" ? "at market" : `${kind} at ${px(num(price))}`}
      </button>
    </form>
  );
}

export default function PaperPage() {
  const { user } = useUser();
  const [state, setState] = useState<PaperState | null>(null);
  const [report, setReport] = useState<Report | null>(null);
  const [profile, setProfile] = useState<RiskProfile | null>(null);
  const [tab, setTab] = useState<Tab>("positions");
  const [busy, setBusy] = useState(false);
  const [toast, setToast] = useState<{ msg: string; tone: "up" | "down" | "info" } | null>(null);
  const [resetOpen, setResetOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const seen = useRef<Set<number> | null>(null);

  const say = useCallback((msg: string, t: "up" | "down" | "info" = "info") => {
    setToast({ msg, tone: t });
    setTimeout(() => setToast((x) => (x?.msg === msg ? null : x)), 4500);
  }, []);

  const load = useCallback(async () => {
    const s = await api.paper();
    // Tell the user about positions the server closed (stop, target or stop-out) since the last look.
    if (seen.current) {
      for (const h of s.history)
        if (!seen.current.has(h.id) && h.close_reason !== "manual")
          say(`${REASON[h.close_reason ?? ""]}: ${signed(h.pnl)}`, (h.pnl ?? 0) >= 0 ? "up" : "down");
    }
    seen.current = new Set(s.history.map((h) => h.id));
    setState(s);
    return s;
  }, [say]);

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
    if (user && tab === "report") api.paperReport().then(setReport, () => {});
  }, [user, tab, closedCount]);

  if (user === null) return <SignInPrompt what="practise trading gold with virtual money" next="/paper" />;
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

  const a = state?.account;
  const level = a?.margin_level_pct;
  return (
    <div className="mx-auto max-w-6xl px-4 py-8">
      <PageHeader icon="wallet" title="Paper trading"
        subtitle="Practise trading gold with virtual money on real XAU/USD prices. Orders fill at the real bid and ask, with spread and overnight swap, but no real money or broker is involved."
        right={
          <div className="relative">
            <button onClick={() => setResetOpen(!resetOpen)} className="rounded-md border border-border px-3 py-1.5 text-sm transition hover:border-muted">
              Reset account
            </button>
            {resetOpen && (
              <div className="quiz-in absolute right-0 z-20 mt-2 w-64 rounded-xl border border-border bg-surface p-3 shadow-2xl">
                <p className="text-sm">Start again with a fresh balance?</p>
                <p className="mt-1 text-xs text-muted">This deletes every paper position, order and result.</p>
                <div className="mt-3 grid grid-cols-2 gap-2">
                  {BALANCES.map((b) => (
                    <button key={b} disabled={busy} onClick={async () => {
                      if (await act(() => api.paperReset(b), `Account reset to ${fmtUsd(b)}`)) setResetOpen(false);
                    }} className="rounded-md border border-border px-2 py-1.5 text-sm tabular-nums transition hover:border-gold disabled:opacity-50">
                      {fmtUsd(b).replace(".00", "")}
                    </button>
                  ))}
                </div>
              </div>
            )}
          </div>
        } />

      {error && !state && <p className="mt-6 text-sm text-down">{error}</p>}
      {!state && !error && <div className="mt-6 h-40 animate-pulse rounded-xl bg-surface" />}

      {state && a && (
        <>
          <div className="mt-6 grid grid-cols-2 gap-3 lg:grid-cols-[1.4fr_1fr_1fr_1fr]">
            <div className="col-span-2 rounded-xl border border-gold/40 bg-gradient-to-br from-gold/15 to-transparent p-3.5 lg:col-span-1">
              <p className="flex items-center gap-1.5 text-xs text-gold"><Icon name="wallet" className="h-3.5 w-3.5" />Account value (equity)</p>
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
                  <span className="mt-1 block h-1.5 overflow-hidden rounded-full bg-border">
                    <span className={`block h-full rounded-full transition-all ${level < 150 ? "bg-down" : level < 400 ? "bg-gold" : "bg-up"}`}
                          style={{ width: `${Math.min(level / 10, 100)}%` }} />
                  </span>
                  <span className="mt-1 block">Margin level {level.toFixed(0)}% · stop-out at {state.settings.stop_out_pct}%</span>
                </span>
              ) : `Up to ${state.settings.max_leverage}x leverage`}>
              {fmtUsd(a.free_margin)}
            </Stat>
          </div>

          <div className="mt-6 grid grid-cols-1 gap-6 lg:grid-cols-[minmax(0,1fr)_340px]">
            <div className="min-w-0 space-y-4">
              <div className="rounded-xl border border-border bg-surface p-4"><Quote price={state.price} /></div>
              <PriceChart height={360} initialTf="1m" />

              <Chips<Tab> value={tab} onChange={setTab} options={[
                { key: "positions", label: "Open positions", count: state.positions.length },
                { key: "orders", label: "Pending orders", count: state.orders.length },
                { key: "history", label: "History", count: a.closed_trades },
                { key: "report", label: "Report" },
              ]} />

              {tab === "positions" && (
                <div className="space-y-3">
                  {state.positions.length === 0 && (
                    <Empty icon="wallet" title="No open positions">Use the order ticket to buy or sell. Try a small size with a stop loss first.</Empty>
                  )}
                  {state.positions.map((p) => (
                    <PositionRow key={p.id} p={p} busy={busy}
                      onClose={() => act(() => api.paperClose(p.id), "Position closed")}
                      onSave={(sl, tp) => act(() => api.paperProtect(p.id, sl, tp), "Stop and target saved")} />
                  ))}
                </div>
              )}

              {tab === "orders" && (
                <div className="space-y-3">
                  {state.orders.length === 0 && <Empty icon="clock" title="No pending orders">Limit and stop orders wait here until the price reaches them.</Empty>}
                  {state.orders.map((o) => (
                    <OrderRow key={o.id} o={o} price={state.price} busy={busy} onCancel={() => act(() => api.paperCancel(o.id), "Order cancelled")} />
                  ))}
                  {state.cancelled_orders.filter((o) => o.note && o.note !== "Cancelled by you").slice(0, 3).map((o) => (
                    <p key={o.id} className="text-xs text-muted">
                      {o.side === "long" ? "Buy" : "Sell"} {o.kind} at {px(o.price)} was cancelled: {o.note.toLowerCase()}.
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
                      <span className="tabular-nums">{h.units} oz</span>
                      <span className="text-xs text-muted tabular-nums">{px(h.entry_price)} → {px(h.exit_price)}</span>
                      <span className="rounded-full bg-border px-2 py-0.5 text-[11px] text-muted">{REASON[h.close_reason ?? ""]}</span>
                      <span className="text-xs text-muted">{h.closed_at && when(h.closed_at)}</span>
                      <span className={`ml-auto font-medium tabular-nums ${tone(h.pnl)}`}>{signed(h.pnl)}</span>
                    </div>
                  ))}
                </div>
              )}

              {tab === "report" && (
                <div className="space-y-4">
                  {report ? <ReportView report={report} kind="paper" /> : <div className="h-32 animate-pulse rounded-xl bg-surface" />}
                  {report && report.stats.trades > 0 && <FitPanel load={api.paperFit} deps={[closedCount]} />}
                </div>
              )}
            </div>

            <aside className="order-first space-y-3 lg:sticky lg:top-20 lg:order-none lg:self-start">
              <h2 className="flex items-center gap-2 font-medium"><Icon name="bolt" className="h-4 w-4 text-gold" />New order</h2>
              <Ticket state={state} profile={profile} busy={busy} setBusy={setBusy}
                onPlaced={async (msg) => { await load(); setTab((t) => (t === "report" || t === "history" ? "positions" : t)); say(msg, "up"); }} />
              <p className="text-xs leading-relaxed text-muted">
                Spread {state.settings.spread.toFixed(2)} per ounce. Overnight swap {state.settings.swap_long.toFixed(2)} long and{" "}
                +{state.settings.swap_short.toFixed(2)} short per ounce. Stops and targets are checked against every minute of real prices,
                even while this page is closed. Practice only, not advice.
              </p>
            </aside>
          </div>
        </>
      )}

      {toast && (
        <div role="status" className={`rise-in fixed bottom-5 left-1/2 z-50 -translate-x-1/2 rounded-full border px-4 py-2 text-sm shadow-2xl backdrop-blur ${
          toast.tone === "up" ? "border-up/50 bg-up/20" : toast.tone === "down" ? "border-down/50 bg-down/20" : "border-border bg-surface/90"}`}>
          {toast.msg}
        </div>
      )}
    </div>
  );
}
