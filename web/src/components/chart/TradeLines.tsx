"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { IChartApi, ISeriesApi } from "lightweight-charts";
import { fmtUsd, type Market, type PaperOrder, type PaperOrderInput, type PaperPosition, type PaperPrice } from "@/lib/api";
import { GOLD, fmtMarketPrice } from "@/lib/markets";

type Side = "long" | "short";
type Role = "entry" | "sl" | "tp";
type OwnerType = "pos" | "order" | "draft";
type Line = {
  key: string; owner: OwnerType; id: number; role: Role; price: number;
  side: Side; units: number; entry: number; draggable: boolean;
};
type Draft = { side: Side; market: boolean; price: number; sl: number | null; tp: number | null; units: string };
// `start` is the line's price when picked up and `p0` the price under the pointer then, so a line moves by
// as much as the pointer does and never jumps to it (a label pinned to the chart's edge stays put at first).
type Drag = { key: string; owner: OwnerType; id: number; role: Role; start: number; p0: number; price: number; y0: number; moved: boolean };
type OrderEdit = { price?: number; stop_loss?: number | null; take_profit?: number | null };

export type TradeActions = {
  protect: (id: number, sl: number | null, tp: number | null) => Promise<boolean>;
  modify: (id: number, body: OrderEdit) => Promise<boolean>;
  cancel: (id: number) => Promise<boolean>;
  close: (id: number) => Promise<boolean>;
  place: (o: PaperOrderInput) => Promise<boolean>;
};

const COLOR: Record<Role, string> = { entry: "var(--calm)", sl: "var(--down)", tp: "var(--up)" };
/** Rounds to a market's price step (two decimals for gold, five for most currencies). */
const roundTo = (v: number, d: number) => Math.round(v * 10 ** d) / 10 ** d;
const dirOf = (s: Side) => (s === "long" ? 1 : -1);
/** Profit or loss if the price reaches `at`, before spread and swap. */
const pnlAt = (side: Side, entry: number, at: number, units: number) => (at - entry) * units * dirOf(side);
const pct = (v: number) => `${Math.abs(v) < 0.1 ? Math.abs(v).toFixed(2) : Math.abs(v).toFixed(1)}%`;
const signedUsd = (v: number) => `${v > 0 ? "+" : v < 0 ? "−" : ""}${fmtUsd(Math.abs(v))}`;

/** The order type a price implies: a buy below the ask waits as a limit, above it as a stop; sells mirror that. */
function kindAt(side: Side, at: number, q: PaperPrice | null): "limit" | "stop" | null {
  if (!q) return null;
  const ref = side === "long" ? q.ask : q.bid;
  if (at === ref) return null;
  return (side === "long") === at < ref ? "limit" : "stop";
}

function Grip() {
  return (
    <svg viewBox="0 0 8 14" className="h-3 w-2 shrink-0 opacity-70" aria-hidden fill="currentColor">
      <circle cx="2" cy="3" r="1.1" /><circle cx="6" cy="3" r="1.1" /><circle cx="2" cy="7" r="1.1" />
      <circle cx="6" cy="7" r="1.1" /><circle cx="2" cy="11" r="1.1" /><circle cx="6" cy="11" r="1.1" />
    </svg>
  );
}

/** Paper orders and positions drawn on the price chart, like a broker's trading chart: drag a pending order's
 *  line to move its price, drag stop loss and take profit lines to move them, and place new orders from the
 *  chart (the Buy and Sell buttons, or right-click / long-press a price). Works with a mouse and with touch. */
export default function TradeLines({ chart, series, below, positions, orders, price, equity, riskLimit, busy, actions, market = GOLD }: {
  market?: Market;
  chart: IChartApi; series: ISeriesApi<"Candlestick">; below: HTMLElement | null;
  positions: PaperPosition[]; orders: PaperOrder[]; price: PaperPrice | null;
  equity: number; riskLimit: number; busy: boolean; actions: TradeActions;
}) {
  const dp = market.decimals;
  const r2 = useCallback((v: number) => roundTo(v, dp), [dp]);
  const fmtPrice = (p: number) => fmtMarketPrice(p, market);
  const unit = market.unit === "ounce" ? "oz" : market.unit === "share" ? "shares" : "units";
  const root = useRef<HTMLDivElement>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [drag, setDrag] = useState<Drag | null>(null);
  const dragRef = useRef<Drag | null>(null);
  // Prices just dropped, shown until the saved account comes back so the line doesn't jump back meanwhile.
  const [held, setHeld] = useState<Record<string, number>>({});
  const [confirm, setConfirm] = useState<string | null>(null);
  const [menu, setMenu] = useState<{ x: number; y: number; price: number } | null>(null);
  const [coarse, setCoarse] = useState(false);
  const [compact, setCompact] = useState(false); // touch screens and narrow windows
  useEffect(() => {
    setCoarse(window.matchMedia("(pointer: coarse)").matches);
    const mq = window.matchMedia("(pointer: coarse), (max-width: 639px)");
    const on = () => setCompact(mq.matches);
    on();
    mq.addEventListener("change", on);
    return () => mq.removeEventListener("change", on);
  }, []);
  useEffect(() => {
    if (!confirm) return;
    const id = setTimeout(() => setConfirm(null), 4000);
    return () => clearTimeout(id);
  }, [confirm]);

  // A market draft follows the live price.
  const draftEntry = draft ? (draft.market ? (price ? (draft.side === "long" ? price.ask : price.bid) : draft.price) : draft.price) : 0;

  const lines: Line[] = [];
  for (const p of positions) {
    const base = { owner: "pos" as const, id: p.id, side: p.side, units: p.units, entry: p.entry_price };
    lines.push({ ...base, key: `pos${p.id}e`, role: "entry", price: p.entry_price, draggable: false });
    if (p.stop_loss != null) lines.push({ ...base, key: `pos${p.id}sl`, role: "sl", price: p.stop_loss, draggable: true });
    if (p.take_profit != null) lines.push({ ...base, key: `pos${p.id}tp`, role: "tp", price: p.take_profit, draggable: true });
  }
  for (const o of orders) {
    const base = { owner: "order" as const, id: o.id, side: o.side, units: o.units, entry: o.price, draggable: true };
    lines.push({ ...base, key: `ord${o.id}e`, role: "entry", price: o.price });
    if (o.stop_loss != null) lines.push({ ...base, key: `ord${o.id}sl`, role: "sl", price: o.stop_loss });
    if (o.take_profit != null) lines.push({ ...base, key: `ord${o.id}tp`, role: "tp", price: o.take_profit });
  }
  if (draft) {
    const base = { owner: "draft" as const, id: 0, side: draft.side, units: Number(draft.units) || 0, entry: draftEntry, draggable: true };
    lines.push({ ...base, key: "draft-e", role: "entry", price: draftEntry });
    if (draft.sl != null) lines.push({ ...base, key: "draft-sl", role: "sl", price: draft.sl });
    if (draft.tp != null) lines.push({ ...base, key: "draft-tp", role: "tp", price: draft.tp });
  }

  // Where a line is drawn right now: under the finger while dragged (an order's stop and target move with it).
  const shown = (l: Line) => {
    const d = drag;
    if (d && d.owner !== "draft" && d.owner === l.owner && d.id === l.id) {
      if (d.key === l.key) return d.price;
      if (d.role === "entry") return l.price + (d.price - d.start);
    }
    return held[l.key] ?? l.price;
  };
  const entryOf = (l: Line) => {
    const e = lines.find((x) => x.owner === l.owner && x.id === l.id && x.role === "entry");
    return e ? shown(e) : l.entry;
  };

  // Follow the chart every frame: panning, zooming and dragging the price scale all move the lines.
  useEffect(() => {
    let raf = 0;
    const tick = () => {
      raf = requestAnimationFrame(tick);
      const el = root.current;
      if (!el) return;
      const plotW = chart.timeScale().width();
      const scaleW = chart.priceScale("right").width();
      const h = chart.panes()[0]?.getHeight() ?? el.clientHeight;
      el.style.setProperty("--plot-w", `${plotW}px`);
      el.style.setProperty("--scale-w", `${scaleW}px`);
      el.style.setProperty("--pane-h", `${h}px`);
      // A level above or below the visible prices is pinned to the edge (under the price legend at the top).
      const legend = el.parentElement?.querySelector<HTMLElement>("[data-chart-legend]");
      const topY = legend ? Math.max(10, legend.offsetTop + legend.offsetHeight + 12) : 10;
      el.querySelectorAll<HTMLElement>("[data-price]").forEach((row) => {
        const y = series.priceToCoordinate(Number(row.dataset.price));
        if (y == null) { row.style.visibility = "hidden"; return; }
        const off = y < 10 ? "up" : y > h - 10 ? "down" : "";
        row.style.visibility = "visible";
        row.style.transform = `translateY(${Math.round(off === "up" ? topY : Math.min(Math.max(y, 10), h - 10))}px)`;
        if (row.dataset.off !== off) row.dataset.off = off;
      });
      // Labels that would cover each other, or the Buy and Sell buttons, step left until they don't.
      const R = el.getBoundingClientRect();
      const box = (n: HTMLElement) => {
        const r = n.getBoundingClientRect();
        return { top: r.top - R.top, bottom: r.bottom - R.top, left: r.left - R.left, right: r.right - R.left };
      };
      const placed = [...el.querySelectorAll<HTMLElement>("[data-obstacle]")].map(box);
      el.querySelectorAll<HTMLElement>("[data-label]").forEach((lab) => {
        lab.style.transform = "";
        if ((lab.parentElement as HTMLElement).style.visibility === "hidden") return;
        const b = box(lab);
        let shift = 0, again = true;
        while (again) {
          again = false;
          for (const p of placed) {
            if (b.top < p.bottom + 2 && b.bottom > p.top - 2 && b.left - shift < p.right + 4 && b.right - shift > p.left - 4) {
              shift = b.right - p.left + 6;
              again = true;
            }
          }
        }
        shift = Math.min(shift, Math.max(b.left - 4, 0));
        if (shift) lab.style.transform = `translateX(${-shift}px)`;
        placed.push({ ...b, left: b.left - shift, right: b.right - shift });
      });
    };
    tick();
    return () => cancelAnimationFrame(raf);
  }, [chart, series]);

  const priceAtY = useCallback((clientY: number) => {
    const r = root.current!.getBoundingClientRect();
    const p = series.coordinateToPrice(clientY - r.top);
    return p == null ? null : r2(p);
  }, [series, r2]);

  // A sensible gap for a new stop or target: about 60 pixels at the current zoom.
  const gapAt = useCallback((at: number) => {
    const y = series.priceToCoordinate(at);
    const p = y == null ? null : series.coordinateToPrice(y + 60);
    const g = p == null ? 0 : Math.abs(at - p);
    return r2(g > 0 ? g : Math.max(at * 0.0025, 10 ** -dp));
  }, [series, r2, dp]);

  // ---- Dragging --------------------------------------------------------------------------------------
  function down(e: React.PointerEvent, l: Line) {
    if (!l.draggable || busy || e.button > 0) return;
    e.preventDefault();
    e.stopPropagation();
    const p0 = priceAtY(e.clientY);
    if (p0 == null) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    const d: Drag = { key: l.key, owner: l.owner, id: l.id, role: l.role, start: shown(l), p0, price: shown(l), y0: e.clientY, moved: false };
    dragRef.current = d;
    setDrag(d);
    setConfirm(null);
    setMenu(null);
  }

  function move(e: React.PointerEvent) {
    const d = dragRef.current;
    if (!d) return;
    if (!d.moved && Math.abs(e.clientY - d.y0) < 3) return;
    const at = priceAtY(e.clientY);
    if (at == null) return;
    const p = r2(d.start + at - d.p0);
    const next = { ...d, price: p, moved: true };
    if (d.owner === "draft") {
      setDraft((dr) => {
        if (!dr) return dr;
        if (d.role === "sl") return { ...dr, sl: p };
        if (d.role === "tp") return { ...dr, tp: p };
        // Moving the entry carries the stop and target along, keeping the risk the same.
        const from = dr.market ? draftEntry : dr.price;
        const shift = p - from;
        return { ...dr, market: false, price: p, sl: dr.sl == null ? null : r2(dr.sl + shift), tp: dr.tp == null ? null : r2(dr.tp + shift) };
      });
    }
    dragRef.current = next;
    setDrag(next);
  }

  async function up() {
    const d = dragRef.current;
    dragRef.current = null;
    if (!d) return;
    if (!d.moved || d.owner === "draft" || d.price === d.start) { setDrag(null); return; }
    const own = lines.filter((x) => x.owner === d.owner && x.id === d.id);
    const get = (role: Role) => own.find((x) => x.role === role)?.price ?? null;
    const shift = d.price - d.start;
    const hold: Record<string, number> = {};
    for (const x of own) hold[x.key] = x.key === d.key ? d.price : d.role === "entry" ? r2(x.price + shift) : (held[x.key] ?? x.price);
    setHeld((h) => ({ ...h, ...hold }));
    setDrag(null);
    if (d.owner === "pos") {
      await actions.protect(d.id, d.role === "sl" ? d.price : get("sl"), d.role === "tp" ? d.price : get("tp"));
    } else if (d.role === "entry") {
      const sl = get("sl"), tp = get("tp");
      await actions.modify(d.id, { price: d.price, stop_loss: sl == null ? null : r2(sl + shift), take_profit: tp == null ? null : r2(tp + shift) });
    } else {
      await actions.modify(d.id, d.role === "sl" ? { stop_loss: d.price } : { take_profit: d.price });
    }
    setHeld((h) => {
      const n = { ...h };
      for (const k of Object.keys(hold)) delete n[k];
      return n;
    });
  }

  // ---- Adding and removing a stop or target -----------------------------------------------------------
  function addLevel(l: Line, role: "sl" | "tp") {
    const dir = dirOf(l.side);
    const p = positions.find((x) => x.id === l.id);
    // For an open position the level must sit beyond the current price as well as the entry.
    const mark = l.owner === "pos" && p?.mark != null ? p.mark : l.entry;
    const g = gapAt(l.entry);
    const at = role === "sl" ? r2((dir > 0 ? Math.min(l.entry, mark) : Math.max(l.entry, mark)) - dir * g)
      : r2((dir > 0 ? Math.max(l.entry, mark) : Math.min(l.entry, mark)) + dir * 2 * g);
    if (l.owner === "draft") setDraft((d) => d && { ...d, [role]: at });
    else if (l.owner === "pos") actions.protect(l.id, role === "sl" ? at : (p?.stop_loss ?? null), role === "tp" ? at : (p?.take_profit ?? null));
    else actions.modify(l.id, role === "sl" ? { stop_loss: at } : { take_profit: at });
  }

  function removeLevel(l: Line) {
    if (l.owner === "draft") setDraft((d) => d && { ...d, [l.role]: null });
    else if (l.owner === "pos") {
      const p = positions.find((x) => x.id === l.id);
      actions.protect(l.id, l.role === "sl" ? null : (p?.stop_loss ?? null), l.role === "tp" ? null : (p?.take_profit ?? null));
    } else actions.modify(l.id, l.role === "sl" ? { stop_loss: null } : { take_profit: null });
  }

  // ---- New orders ---------------------------------------------------------------------------------------
  const startDraft = useCallback((side: Side, at: number | null) => {
    const ref = price ? (side === "long" ? price.ask : price.bid) : at;
    const entry = at ?? ref;
    if (entry == null) return;
    const g = gapAt(entry), dir = dirOf(side);
    // The first draft is sized so its stop risks the profile's limit; later ones keep the size last used.
    const fit = Math.max(Math.floor(((equity * riskLimit) / 100 / g) * 100) / 100, 0.01);
    setDraft((d) => ({ side, market: at == null, price: entry, sl: r2(entry - dir * g), tp: r2(entry + dir * 2 * g), units: d?.units ?? String(fit) }));
    setMenu(null);
  }, [price, gapAt, equity, riskLimit, r2]);

  // Right-click a price (or press and hold it on a touch screen) to place an order there.
  useEffect(() => {
    const el = chart.chartElement();
    const open = (clientX: number, clientY: number) => {
      const r = root.current?.getBoundingClientRect();
      if (!r) return;
      const x = clientX - r.left, y = clientY - r.top;
      const h = chart.panes()[0]?.getHeight() ?? r.height;
      if (x < 0 || x > chart.timeScale().width() || y < 0 || y > h) return;
      const p = series.coordinateToPrice(y);
      if (p != null) setMenu({ x, y, price: r2(p) });
    };
    const onMenu = (e: MouseEvent) => { e.preventDefault(); open(e.clientX, e.clientY); };
    let timer: ReturnType<typeof setTimeout> | undefined, sx = 0, sy = 0;
    const clear = () => { clearTimeout(timer); timer = undefined; };
    const onDown = (e: PointerEvent) => {
      if (e.pointerType !== "touch") return;
      sx = e.clientX; sy = e.clientY;
      clear();
      timer = setTimeout(() => open(sx, sy), 550);
    };
    const onMove = (e: PointerEvent) => { if (timer && Math.hypot(e.clientX - sx, e.clientY - sy) > 10) clear(); };
    el.addEventListener("contextmenu", onMenu);
    el.addEventListener("pointerdown", onDown);
    el.addEventListener("pointermove", onMove);
    el.addEventListener("pointerup", clear);
    el.addEventListener("pointercancel", clear);
    return () => {
      clear();
      el.removeEventListener("contextmenu", onMenu);
      el.removeEventListener("pointerdown", onDown);
      el.removeEventListener("pointermove", onMove);
      el.removeEventListener("pointerup", clear);
      el.removeEventListener("pointercancel", clear);
    };
  }, [chart, series, r2]);

  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      setMenu(null);
      setConfirm(null);
      if (!dragRef.current) setDraft(null);
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, []);

  // ---- The draft's numbers, read before placing it ------------------------------------------------------
  const units = draft ? Number(draft.units) || 0 : 0;
  const draftKind = draft ? (draft.market ? "market" : kindAt(draft.side, draft.price, price)) : null;
  const dDir = draft ? dirOf(draft.side) : 1;
  const risk = draft?.sl != null ? -pnlAt(draft.side, draftEntry, draft.sl, units) : null;
  const reward = draft?.tp != null ? pnlAt(draft.side, draftEntry, draft.tp, units) : null;
  const riskPct = risk != null && equity > 0 ? (risk / equity) * 100 : null;
  let problem: string | null = null;
  if (draft) {
    if (!units) problem = "Choose a size.";
    else if (draft.sl != null && (draft.sl - draftEntry) * dDir >= 0) problem = `The stop loss must be ${draft.side === "long" ? "below" : "above"} the entry.`;
    else if (draft.tp != null && (draft.tp - draftEntry) * dDir <= 0) problem = `The take profit must be ${draft.side === "long" ? "above" : "below"} the entry.`;
    else if (!draftKind) problem = "Move the entry off the current price, or switch to market.";
    else if (draftKind === "market" && price && !price.open) problem = "The market looks closed. Drag the entry to a price to leave a limit or stop order instead.";
  }
  const over = riskPct != null && riskPct > riskLimit + 0.05;

  async function place() {
    if (!draft || problem || !draftKind) return;
    const ok = await actions.place({
      side: draft.side, kind: draftKind, units,
      price: draftKind === "market" ? null : draft.price, stop_loss: draft.sl, take_profit: draft.tp,
    });
    if (ok) setDraft(null);
  }

  function sizeToLimit() {
    if (!draft || draft.sl == null || draft.sl === draftEntry) return;
    const oz = (equity * riskLimit) / 100 / Math.abs(draftEntry - draft.sl);
    setDraft({ ...draft, units: String(Math.max(Math.floor(oz * 100) / 100, 0.01)) });
  }

  // ---- Drawing ------------------------------------------------------------------------------------------
  const chip = "pointer-events-auto flex items-center gap-1 whitespace-nowrap rounded-md border bg-surface/95 px-1.5 text-[11px] font-medium tabular-nums shadow-md backdrop-blur";
  const mini = "pointer-events-auto rounded px-1 leading-4 transition hover:bg-surface-2";
  const tall = coarse ? "h-7" : "h-6";

  function label(l: Line) {
    const at = shown(l);
    const entry = entryOf(l);
    const own = lines.filter((x) => x.owner === l.owner && x.id === l.id);
    const has = (r: Role) => own.some((x) => x.role === r);
    const ck = `${l.owner}${l.id}`;
    if (l.role === "entry") {
      const pos = l.owner === "pos" ? positions.find((p) => p.id === l.id) : null;
      const ord = l.owner === "order" ? orders.find((o) => o.id === l.id) : null;
      const verb = l.side === "long" ? "Buy" : "Sell";
      const text = l.owner === "pos" ? `${verb} ${l.units} ${unit}`
        : l.owner === "order" ? `${verb} ${ord?.kind ?? ""} ${l.units} ${unit}`
        : `${verb} ${draftKind ?? ""} ${draft?.units || 0} ${unit}`.replace("  ", " ");
      return (
        <>
          {l.draggable && <Grip />}
          <span>{text}</span>
          {pos?.pnl != null && <span className={pos.pnl >= 0 ? "text-up" : "text-down"}>{signedUsd(pos.pnl)}</span>}
          {!has("sl") && <button type="button" onPointerDown={(e) => e.stopPropagation()} onClick={() => addLevel(l, "sl")} disabled={busy}
            className={`${mini} text-down`} title="Add a stop loss, then drag it" aria-label="Add a stop loss">+SL</button>}
          {!has("tp") && <button type="button" onPointerDown={(e) => e.stopPropagation()} onClick={() => addLevel(l, "tp")} disabled={busy}
            className={`${mini} text-up`} title="Add a take profit, then drag it" aria-label="Add a take profit">+TP</button>}
          {l.owner === "draft" ? (
            <button type="button" onPointerDown={(e) => e.stopPropagation()} onClick={() => setDraft(null)} className={`${mini} text-muted`} aria-label="Discard this order">✕</button>
          ) : confirm === ck ? (
            <button type="button" onPointerDown={(e) => e.stopPropagation()} disabled={busy}
              onClick={() => { setConfirm(null); if (l.owner === "pos") actions.close(l.id); else actions.cancel(l.id); }}
              className={`${mini} bg-down/15 text-down`}>{l.owner === "pos" ? "Close it?" : "Cancel it?"}</button>
          ) : (
            <button type="button" onPointerDown={(e) => e.stopPropagation()} onClick={() => setConfirm(ck)} disabled={busy}
              className={`${mini} text-muted hover:text-down`} title={l.owner === "pos" ? "Close this position" : "Cancel this order"}
              aria-label={l.owner === "pos" ? "Close this position" : "Cancel this order"}>✕</button>
          )}
        </>
      );
    }
    const v = pnlAt(l.side, entry, at, l.units);
    const riskV = own.find((x) => x.role === "sl");
    const rr = l.role === "tp" && riskV ? Math.abs(at - entry) / Math.abs(entry - shown(riskV) || 1) : null;
    return (
      <>
        <Grip />
        <span style={{ color: COLOR[l.role] }}>{l.role === "sl" ? "SL" : "TP"}</span>
        <span className={v >= 0 ? "text-up" : "text-down"}>{signedUsd(v)}</span>
        {equity > 0 && <span className="text-muted">{pct((v / equity) * 100)}</span>}
        {rr != null && <span className="text-muted">{rr.toFixed(1)}R</span>}
        <button type="button" onPointerDown={(e) => e.stopPropagation()} onClick={() => removeLevel(l)} disabled={busy}
          className={`${mini} text-muted hover:text-down`} aria-label={`Remove the ${l.role === "sl" ? "stop loss" : "take profit"}`}>✕</button>
      </>
    );
  }

  const quick = (
    <div className="pointer-events-auto flex shrink-0 overflow-hidden rounded-lg border border-border bg-surface/95 text-xs font-semibold shadow-lg backdrop-blur"
      title="Set up an order on the chart. You can also right-click a price, or press and hold it on a touch screen.">
      <button type="button" onClick={() => startDraft("short", null)} disabled={!price}
        className={`flex flex-col items-start px-2.5 transition hover:bg-down/10 disabled:opacity-50 text-down ${compact ? "py-1.5" : "py-1"}`}>
        <span>Sell</span><span className="font-normal tabular-nums">{price ? fmtPrice(price.bid) : "–"}</span>
      </button>
      <span className="w-px bg-border" />
      <button type="button" onClick={() => startDraft("long", null)} disabled={!price}
        className={`flex flex-col items-end px-2.5 transition hover:bg-up/10 disabled:opacity-50 text-up ${compact ? "py-1.5" : "py-1"}`}>
        <span>Buy</span><span className="font-normal tabular-nums">{price ? fmtPrice(price.ask) : "–"}</span>
      </button>
    </div>
  );

  const card = draft && (
    <div className="rise-in space-y-2">
      <div className="flex flex-wrap items-center gap-1.5">
        <div className="flex overflow-hidden rounded-lg border border-border">
          {(["long", "short"] as const).map((s) => (
            <button key={s} type="button" aria-pressed={draft.side === s}
              onClick={() => s !== draft.side && startDraft(s, draft.market ? null : draft.price)}
              className={`px-2.5 py-1 font-semibold ${draft.side === s ? (s === "long" ? "bg-up/20 text-up" : "bg-down/20 text-down") : "text-muted"}`}>
              {s === "long" ? "Buy" : "Sell"}
            </button>
          ))}
        </div>
        <span className="rounded-full bg-border px-2 py-0.5 capitalize">{draftKind ?? "–"}</span>
        {!draft.market && (
          <button type="button" onClick={() => setDraft({ ...draft, market: true })} className="text-gold hover:underline">Use market</button>
        )}
        <label className="ml-auto flex items-center gap-1 text-muted">
          <input value={draft.units} onChange={(e) => setDraft({ ...draft, units: e.target.value })} inputMode="decimal" aria-label={`Size in ${unit}`}
            className="w-20 rounded-md border border-border bg-background px-1.5 py-1 text-right text-base tabular-nums text-foreground outline-none focus:border-gold sm:text-xs" />
          {unit}
        </label>
      </div>
      <p className="leading-relaxed text-muted">
        {draft.side === "long" ? "Buy" : "Sell"} {units || 0} {unit} {draft.market ? <>at about <b className="text-foreground">{fmtPrice(draftEntry)}</b></> : <>if {market.symbol === GOLD.symbol ? "gold" : market.name} reaches <b className="text-foreground">{fmtPrice(draft.price)}</b></>}.{" "}
        {risk != null && riskPct != null
          ? <>Stop at {fmtPrice(draft.sl!)}: lose <b className={over ? "text-down" : "text-foreground"}>{fmtUsd(risk)}</b> ({pct(riskPct)}{over ? `, over your ${riskLimit}% limit` : ""}).</>
          : <>No stop loss, so the loss isn&apos;t limited.</>}{" "}
        {reward != null && <>Target {fmtPrice(draft.tp!)}: make <b className="text-up">{fmtUsd(reward)}</b>.</>}{" "}
        <span className="hidden sm:inline">Drag the lines on the chart to adjust.</span>
      </p>
      {problem && <p className="text-down">{problem}</p>}
      <div className="flex items-center gap-2">
        {draft.sl != null && <button type="button" onClick={sizeToLimit} className="whitespace-nowrap text-gold hover:underline">Size to {riskLimit}%</button>}
        <button type="button" onClick={() => setDraft(null)} className="ml-auto rounded-full border border-border px-3 py-1.5 hover:bg-surface-2">Cancel</button>
        <button type="button" onClick={place} disabled={busy || !!problem}
          className={`whitespace-nowrap rounded-full px-3 py-1.5 font-semibold text-black disabled:opacity-50 ${draft.side === "long" ? "bg-up" : "bg-down"}`}>
          {busy ? "Placing…" : `Place ${draft.side === "long" ? "buy" : "sell"}${draftKind && draftKind !== "market" ? ` ${draftKind}` : ""}`}
        </button>
      </div>
    </div>
  );

  const menuKinds = menu && price ? ([
    ["long", kindAt("long", menu.price, price)], ["short", kindAt("short", menu.price, price)],
  ] as const) : [];

  return (
    <div ref={root} className="pointer-events-none absolute inset-0 z-[2] overflow-hidden select-none">
      {lines.map((l) => {
        const at = shown(l);
        const col = l.owner === "draft" && l.role === "entry" ? "var(--gold)" : COLOR[l.role];
        const dashed = l.owner !== "pos" || l.role !== "entry";
        const active = drag?.key === l.key;
        const grab = l.draggable ? (active ? "cursor-grabbing" : "cursor-ns-resize") : "";
        return (
          <div key={l.key} data-price={at} className="group absolute left-0 top-0 h-0 w-full data-[off=down]:opacity-70 data-[off=up]:opacity-70" style={{ visibility: "hidden" }}>
            <div className="absolute left-0 top-0 h-0 w-[var(--plot-w)] border-t group-data-[off=down]:hidden group-data-[off=up]:hidden"
              style={{ borderColor: col, borderTopStyle: dashed ? "dashed" : "solid", borderTopWidth: active ? 2 : 1, opacity: l.owner === "pos" && l.role === "entry" ? 0.9 : 1 }} />
            {/* The whole line is a handle for a mouse; on touch only the label is, so the chart still pans. */}
            {l.draggable && !coarse && (
              <div className={`pointer-events-auto absolute left-0 h-3 w-[var(--plot-w)] -translate-y-1/2 touch-none ${grab}`}
                onPointerDown={(e) => down(e, l)} onPointerMove={move} onPointerUp={up} onPointerCancel={up} />
            )}
            <div data-label className={`${chip} ${tall} ${grab} absolute -translate-y-1/2 touch-none ${l.owner === "draft" ? "ring-1 ring-gold/50" : ""}`}
              style={{ borderColor: col, right: `calc(100% - var(--plot-w) + ${l.role === "entry" ? 64 : 8}px)` }}
              onPointerDown={(e) => down(e, l)} onPointerMove={move} onPointerUp={up} onPointerCancel={up}>
              <span className="hidden group-data-[off=up]:inline" aria-hidden>↑</span>
              <span className="hidden group-data-[off=down]:inline" aria-hidden>↓</span>
              {label(l)}
            </div>
            <div className="absolute flex h-5 -translate-y-1/2 items-center px-1 text-[11px] font-medium tabular-nums text-black"
              style={{ left: "var(--plot-w)", width: "var(--scale-w)", background: col }}>
              {fmtPrice(at)}
            </div>
          </div>
        );
      })}

      {menu && (
        <>
          <div className="pointer-events-auto absolute inset-0" onPointerDown={() => setMenu(null)} onContextMenu={(e) => { e.preventDefault(); setMenu(null); }} />
          <div data-price={menu.price} className="absolute left-0 top-0 h-0 w-full">
            <div className="absolute left-0 top-0 h-0 w-[var(--plot-w)] border-t border-dashed border-gold" />
          </div>
          <div role="menu" aria-label={`Order at ${fmtPrice(menu.price)}`}
            className="rise-in pointer-events-auto absolute z-10 w-52 rounded-xl border border-border bg-surface p-1 text-sm shadow-2xl"
            style={{ left: `min(${menu.x}px, calc(var(--plot-w) - 13.5rem))`, top: `min(${menu.y + 8}px, calc(var(--pane-h) - 9rem))` }}>
            <p className="px-2 py-1 text-[11px] text-muted">At {fmtPrice(menu.price)}</p>
            {menuKinds.map(([side, kind]) => kind && (
              <button key={side} type="button" role="menuitem" onClick={() => startDraft(side, menu.price)}
                className={`flex w-full items-center justify-between rounded-lg px-2 py-1.5 text-left hover:bg-surface-2 ${side === "long" ? "text-up" : "text-down"}`}>
                <span>{side === "long" ? "Buy" : "Sell"} {kind}</span><span className="tabular-nums">{fmtPrice(menu.price)}</span>
              </button>
            ))}
            <div className="my-1 h-px bg-border" />
            {(["long", "short"] as const).map((side) => (
              <button key={side} type="button" role="menuitem" onClick={() => startDraft(side, null)}
                className="flex w-full items-center justify-between rounded-lg px-2 py-1.5 text-left text-muted hover:bg-surface-2 hover:text-foreground">
                <span>{side === "long" ? "Buy" : "Sell"} at market</span>
                {price && <span className="tabular-nums">{fmtPrice(side === "long" ? price.ask : price.bid)}</span>}
              </button>
            ))}
          </div>
        </>
      )}

      {/* With a mouse, Buy and Sell sit on the chart; on a phone they go in the bar under it. */}
      {!draft && !compact && (
        <div className="absolute" style={{ top: "calc(var(--pane-h) - 0.5rem)", right: "calc(var(--scale-w) + 0.5rem)", transform: "translateY(-100%)" }}>
          <div data-obstacle>{quick}</div>
        </div>
      )}
      {below && (draft || compact) && createPortal(
        <div className="border-t border-border px-3 py-2.5 text-xs">{draft ? card : (
          <div className="flex items-center gap-3">
            {quick}
            <span className="text-[11px] leading-snug text-muted">Or press and hold a price on the chart for a limit or stop order there.</span>
          </div>
        )}</div>, below)}
    </div>
  );
}
