"use client";

import { useState } from "react";
import { usePref } from "@/lib/prefs";
import { Icon } from "./ui";

/** What the user would really trade with, what they earn and what they are saving for, in their own currency.
 *  Paper results are shown as a share of the paper account, so they scale onto these real amounts. */
export type Mirror = { currency: string; stake: number; monthly: number; hours: number; goal: string; goal_amount: number };

const EMPTY: Mirror = { currency: "USD", stake: 0, monthly: 0, hours: 160, goal: "", goal_amount: 0 };
const CURRENCIES = ["USD", "INR", "EUR", "GBP", "AED", "AUD", "CAD", "SGD", "JPY", "ZAR", "NGN", "PKR", "BDT"];

export function useMirror() {
  return usePref<Mirror>("mirror", "goldlab-mirror", EMPTY);
}

export const mirrorReady = (m: Mirror) => m.stake > 0;

export function money(v: number, currency: string) {
  try {
    return new Intl.NumberFormat(currency === "INR" ? "en-IN" : "en-US", { style: "currency", currency, maximumFractionDigits: 0 }).format(v);
  } catch {
    return `${currency} ${Math.round(v).toLocaleString("en-US")}`;
  }
}

function hoursText(h: number) {
  if (h < 1) return `${Math.max(1, Math.round(h * 60))} minutes`;
  if (h < 16) return `${h < 3 ? h.toFixed(1) : Math.round(h)} hours`;
  const days = h / 8;
  return `${days < 10 ? days.toFixed(1) : Math.round(days)} working days`;
}

/** "That is ₹3,600 of your real ₹2,00,000: about 6 hours of your work, 6% of your Goa trip." */
export function mirrorParts(m: Mirror, sharePct: number) {
  const amount = (m.stake * Math.abs(sharePct)) / 100;
  const hourly = m.monthly > 0 && m.hours > 0 ? m.monthly / m.hours : 0;
  return {
    amount,
    work: hourly > 0 ? hoursText(amount / hourly) : null,
    goal: m.goal_amount > 0 ? (amount / m.goal_amount) * 100 : null,
  };
}

const field = "mt-1 w-full rounded-lg border border-border bg-background px-3 py-2 text-sm outline-none focus:border-gold/60";

export function MirrorForm({ value, onSave, onCancel }: { value: Mirror; onSave: (m: Mirror) => void; onCancel?: () => void }) {
  const [m, setM] = useState<Mirror>(value.stake ? value : { ...value, currency: value.currency || "USD" });
  const num = (k: keyof Mirror) => ({
    value: m[k] ? String(m[k]) : "",
    inputMode: "decimal" as const,
    onChange: (e: React.ChangeEvent<HTMLInputElement>) => setM({ ...m, [k]: Math.max(0, Number(e.target.value.replace(/[^0-9.]/g, "")) || 0) }),
  });
  return (
    <form className="grid gap-3 text-sm sm:grid-cols-2" onSubmit={(e) => { e.preventDefault(); if (m.stake > 0) onSave(m); }}>
      <label className="text-muted">Your currency
        <select id="mirror-currency" value={m.currency} onChange={(e) => setM({ ...m, currency: e.target.value })} className={field}>
          {CURRENCIES.map((c) => <option key={c}>{c}</option>)}
        </select>
      </label>
      <label className="text-muted">Money you might really trade with
        <input id="mirror-stake" {...num("stake")} placeholder="200000" className={field} required />
      </label>
      <label className="text-muted">Monthly take-home pay <span className="text-xs">(optional)</span>
        <input id="mirror-monthly" {...num("monthly")} placeholder="60000" className={field} />
      </label>
      <label className="text-muted">Hours you work a month
        <input id="mirror-hours" {...num("hours")} placeholder="160" className={field} />
      </label>
      <label className="text-muted">Something you are saving for <span className="text-xs">(optional)</span>
        <input id="mirror-goal" value={m.goal} maxLength={40} onChange={(e) => setM({ ...m, goal: e.target.value })} placeholder="Goa trip" className={field} />
      </label>
      <label className="text-muted">What it costs
        <input id="mirror-goal-amount" {...num("goal_amount")} placeholder="60000" className={field} />
      </label>
      <p className="text-xs text-muted sm:col-span-2">Kept in your account only, and used only to translate practice results into your own money.</p>
      <div className="flex gap-2 sm:col-span-2">
        <button type="submit" disabled={!(m.stake > 0)} className="rounded-full bg-gradient-to-b from-gold-hi to-gold px-5 py-2 text-sm font-semibold text-black disabled:opacity-50">Save</button>
        {onCancel && <button type="button" onClick={onCancel} className="rounded-full border border-border px-5 py-2 text-sm hover:bg-surface-2">Cancel</button>}
      </div>
    </form>
  );
}

/** On the order ticket: the risk on this trade, scaled onto the user's real money, hours of work and goal. */
export function MirrorLine({ riskPct }: { riskPct: number | null }) {
  const [m, setM, loaded] = useMirror();
  const [editing, setEditing] = useState(false);
  if (!loaded) return null;
  if (editing) return <div className="rounded-lg border border-calm/30 bg-calm/5 p-3"><MirrorForm value={m} onSave={(v) => { setM(v); setEditing(false); }} onCancel={() => setEditing(false)} /></div>;
  if (!mirrorReady(m)) {
    return (
      <button type="button" onClick={() => setEditing(true)} className="flex items-center gap-1.5 text-xs text-calm hover:underline">
        <Icon name="wallet" className="h-3.5 w-3.5" /> See this risk in your own money
      </button>
    );
  }
  if (riskPct == null) return null;
  const p = mirrorParts(m, riskPct);
  return (
    <p className="flex items-start gap-2 rounded-lg border border-calm/30 bg-calm/5 p-2.5 text-xs leading-relaxed">
      <Icon name="wallet" className="mt-0.5 h-3.5 w-3.5 shrink-0 text-calm" />
      <span>
        With your real {money(m.stake, m.currency)}, this stop would cost <span className="font-semibold">{money(p.amount, m.currency)}</span>
        {p.work && <>, about <span className="font-semibold">{p.work}</span> of your work</>}
        {p.goal != null && m.goal && <>, or <span className="font-semibold">{p.goal < 10 ? p.goal.toFixed(1) : Math.round(p.goal)}%</span> of your {m.goal}</>}.
        {" "}<button type="button" onClick={() => setEditing(true)} className="text-calm hover:underline">Edit</button>
      </span>
    </p>
  );
}

/** On the home desk: paper results so far, as if they had been made with the user's real money, filling a goal jar. */
export function MirrorJar({ returnPct }: { returnPct: number | null }) {
  const [m, setM, loaded] = useMirror();
  const [editing, setEditing] = useState(false);
  if (!loaded) return <div className="h-24 animate-pulse rounded-xl bg-surface-2" />;
  if (editing || !mirrorReady(m)) {
    return editing ? <MirrorForm value={m} onSave={(v) => { setM(v); setEditing(false); }} onCancel={() => setEditing(false)} /> : (
      <div className="space-y-2 text-sm">
        <p className="text-muted">Percentages feel abstract. Tell the Lab what you might really trade with and what you are saving for, and every risk shows up in your own money.</p>
        <button type="button" onClick={() => setEditing(true)} className="text-gold hover:underline">Set up Money Mirror</button>
      </div>
    );
  }
  const r = returnPct ?? 0;
  const amount = (m.stake * r) / 100;
  const fill = m.goal_amount > 0 ? Math.max(0, Math.min(1, amount / m.goal_amount)) : 0;
  return (
    <div className="flex items-center gap-4">
      {m.goal_amount > 0 && (
        <svg viewBox="0 0 60 80" className="h-24 w-16 shrink-0" role="img" aria-label={`${Math.round(fill * 100)}% of ${m.goal}`}>
          <defs><clipPath id="jar-clip"><path d="M14 14h32v6c6 4 8 10 8 18v30a8 8 0 0 1-8 8H14a8 8 0 0 1-8-8V38c0-8 2-14 8-18Z" /></clipPath></defs>
          <rect x="0" y={78 - fill * 62} width="60" height={fill * 62 + 2} fill="var(--gold)" fillOpacity={0.55} clipPath="url(#jar-clip)" />
          <path d="M14 14h32v6c6 4 8 10 8 18v30a8 8 0 0 1-8 8H14a8 8 0 0 1-8-8V38c0-8 2-14 8-18Z" fill="none" stroke="var(--muted)" strokeWidth="1.6" />
          <rect x="12" y="6" width="36" height="8" rx="2" fill="none" stroke="var(--muted)" strokeWidth="1.6" />
        </svg>
      )}
      <div className="min-w-0 space-y-1 text-sm">
        <p className="text-muted">If your paper results were real money</p>
        <p className={`text-2xl font-bold tabular-nums ${amount > 0 ? "text-up" : amount < 0 ? "text-down" : ""}`}>
          {amount > 0 ? "+" : amount < 0 ? "-" : ""}{money(Math.abs(amount), m.currency)}
        </p>
        <p className="text-xs text-muted">
          on {money(m.stake, m.currency)}
          {m.goal_amount > 0 && m.goal ? <> · {amount >= 0 ? `${Math.round(fill * 100)}% of the way to your ${m.goal}` : `the ${m.goal} moves further away`}</> : null}
        </p>
        <button type="button" onClick={() => setEditing(true)} className="text-xs text-gold hover:underline">Edit</button>
      </div>
    </div>
  );
}
