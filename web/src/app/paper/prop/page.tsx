"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import RulePanel, { phaseName, StatusPill } from "@/components/prop/RulePanel";
import SignInPrompt from "@/components/SignInPrompt";
import { toast } from "@/components/Toaster";
import { Icon, PageHeader } from "@/components/ui";
import { api, fmtUsd, type PropChallenge, type PropOverview, type PropPlan, type PropStartInput } from "@/lib/api";
import { useUser } from "@/lib/useUser";

const short = (v: number) => (v >= 1000 ? `$${v / 1000}k` : `$${v}`);
const input = "w-full rounded-lg border border-border bg-background px-3 py-2 text-base tabular-nums outline-none transition focus:border-gold sm:text-sm";
const date = (iso: string | null) => (iso ? new Date(iso).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" }) : "–");

type PlanId = PropStartInput["plan"];

function RuleList({ targets, daily, max, days, lev, size }: { targets: number[]; daily: number; max: number; days: number; lev: number; size: number }) {
  const rows: [string, string][] = [
    ["Profit target", targets.map((t, i) => `${targets.length > 1 ? `Phase ${i + 1}: ` : ""}+${t}% (${fmtUsd(size * t / 100)})`).join(" · ")],
    ["Daily loss limit", `${daily}% (${fmtUsd(size * daily / 100)}) below the day's starting balance`],
    ["Maximum loss", `${max}% (${fmtUsd(size * max / 100)}): equity must stay above ${fmtUsd(size * (1 - max / 100))}`],
    ["Minimum trading days", days ? `${days} per phase` : "None"],
    ["Leverage", `1:${lev}`],
  ];
  return (
    <dl className="mt-3 divide-y divide-border rounded-xl border border-border text-sm">
      {rows.map(([k, v]) => (
        <div key={k} className="flex flex-wrap gap-x-3 gap-y-0.5 px-3 py-2">
          <dt className="w-40 shrink-0 text-muted">{k}</dt>
          <dd className="min-w-0 flex-1 tabular-nums">{v}</dd>
        </div>
      ))}
    </dl>
  );
}

function Picker({ plans, maxLev, replacing, onStarted }: {
  plans: PropPlan[]; maxLev: number; replacing: PropChallenge | null; onStarted: (ch: PropChallenge) => void;
}) {
  const [plan, setPlan] = useState<PlanId>("starter");
  const [size, setSize] = useState(10_000);
  const [custom, setCustom] = useState({ t1: "10", t2: "", daily: "5", max: "10", days: "4", lev: "100", size: "100000" });
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const p = plans.find((x) => x.id === plan);
  const n = (v: string) => Number(v);

  const choose = (id: PlanId) => {
    setPlan(id);
    setConfirm(false);
    const pl = plans.find((x) => x.id === id);
    if (pl && !pl.sizes.includes(size)) setSize(pl.sizes.includes(100_000) ? 100_000 : pl.sizes[0]);
  };

  const body: PropStartInput = plan === "custom"
    ? { plan, size: n(custom.size), custom: {
        targets: [n(custom.t1), ...(custom.t2.trim() ? [n(custom.t2)] : [])],
        daily_loss_pct: n(custom.daily), max_loss_pct: n(custom.max), min_days: Math.round(n(custom.days)), leverage: Math.round(n(custom.lev)) } }
    : { plan, size };

  async function start() {
    setBusy(true);
    setError(null);
    try {
      const r = await api.propStart(body);
      toast(`Challenge started: ${r.current.label}, ${fmtUsd(r.current.size)}`, { tone: "fill", body: "Your paper account is set up with the challenge's balance and leverage." });
      onStarted(r.current);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't start the challenge");
    } finally {
      setBusy(false);
    }
  }

  const field = (key: keyof typeof custom, label: string, suffix?: string) => (
    <label className="text-xs text-muted">{label}
      <span className="relative mt-1 block">
        <input value={custom[key]} onChange={(e) => { setCustom({ ...custom, [key]: e.target.value }); setConfirm(false); }} inputMode="decimal" className={input} />
        {suffix && <span className="pointer-events-none absolute inset-y-0 right-3 flex items-center text-xs text-muted">{suffix}</span>}
      </span>
    </label>
  );

  return (
    <section className="mt-6">
      <h2 className="font-semibold">{replacing ? "Start a new challenge" : "Choose a challenge"}</h2>
      <div className="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {[...plans, { id: "custom" as const, label: "Custom rules", blurb: "Copy any programme's rules: target, limits, days and leverage." }].map((pl) => (
          <button key={pl.id} type="button" onClick={() => choose(pl.id)} aria-pressed={plan === pl.id}
            className={`relative rounded-2xl border p-4 text-left transition ${plan === pl.id ? "border-gold bg-gold/10" : "border-border bg-surface hover:border-muted"}`}>
            {pl.id === "starter" && <span className="absolute right-3 top-3 rounded-full bg-gold/15 px-2 py-0.5 text-[10px] font-medium text-gold">Good first try</span>}
            <p className="font-medium">{pl.label}</p>
            <p className="mt-1 text-xs text-muted">{pl.blurb}</p>
          </button>
        ))}
      </div>

      <div className="mt-4 rounded-2xl border border-border bg-surface p-4">
        {p ? (
          <>
            {p.sizes.length > 1 && (
              <div className="flex flex-wrap items-center gap-1.5">
                <span className="mr-1 text-sm text-muted">Account size</span>
                {p.sizes.map((s) => (
                  <button key={s} type="button" onClick={() => { setSize(s); setConfirm(false); }} aria-pressed={size === s}
                    className={`rounded-full border px-3 py-1 text-xs tabular-nums transition ${size === s ? "border-gold bg-gold/15" : "border-border text-muted hover:border-muted"}`}>{short(s)}</button>
                ))}
              </div>
            )}
            <RuleList targets={p.targets} daily={p.daily_loss_pct} max={p.max_loss_pct} days={p.min_days} lev={p.leverage} size={size} />
          </>
        ) : (
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            {field("size", "Account size", "$")}
            {field("t1", "Phase 1 target", "%")}
            {field("t2", "Phase 2 target (optional)", "%")}
            {field("lev", `Leverage 1:N (up to ${maxLev})`)}
            {field("daily", "Daily loss limit", "%")}
            {field("max", "Maximum loss", "%")}
            {field("days", "Minimum trading days")}
          </div>
        )}
        <p className="mt-3 text-xs text-muted">
          Limits are checked on every minute of prices, against equity including open trades. A day runs 17:00 to 17:00 New York time.
          The challenge runs on your paper account, so it trades every market there and the strategy agent can trade it too.
        </p>
        {error && <p role="alert" className="mt-3 text-sm text-down">{error}</p>}
        {confirm ? (
          <div className="quiz-in mt-3 rounded-xl border border-down/40 bg-down/5 p-3 text-sm">
            <p>Starting clears your paper account&apos;s positions, orders and trade history{replacing?.status === "active" ? ", and ends the challenge you're in" : ""}. Continue?</p>
            <div className="mt-3 flex flex-wrap gap-2">
              <button disabled={busy} onClick={start} className="rounded-full bg-gradient-to-b from-gold-hi to-gold px-5 py-2 text-sm font-semibold text-black disabled:opacity-50">
                {busy ? "Starting…" : "Yes, start the challenge"}
              </button>
              <button onClick={() => setConfirm(false)} className="rounded-full border border-border px-4 py-2 text-sm">Not yet</button>
            </div>
          </div>
        ) : (
          <button onClick={() => setConfirm(true)} className="mt-3 rounded-full bg-gradient-to-b from-gold-hi to-gold px-5 py-2 text-sm font-semibold text-black">
            Start {p ? `${p.label} · ${fmtUsd(size)}` : "custom challenge"}
          </button>
        )}
      </div>
    </section>
  );
}

function History({ items }: { items: PropChallenge[] }) {
  if (!items.length) return null;
  return (
    <section className="mt-8">
      <h2 className="font-semibold">Your challenges</h2>
      <ul className="mt-3 divide-y divide-border rounded-2xl border border-border bg-surface">
        {items.map((h) => {
          const r = h.final ?? h.phase_results[h.phase_results.length - 1];
          return (
            <li key={h.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-4 py-3 text-sm">
              <StatusPill status={h.status} />
              <span className="font-medium">{h.label} · {fmtUsd(h.size)}</span>
              <span className="text-xs text-muted">{phaseName(h)} · {date(h.started_at)}{h.ended_at ? ` to ${date(h.ended_at)}` : ""}</span>
              <span className="ml-auto text-xs tabular-nums text-muted">
                {r ? `${r.profit_pct >= 0 ? "+" : ""}${r.profit_pct.toFixed(2)}% · ${r.trades} trade${r.trades === 1 ? "" : "s"} · worst dip ${r.max_drawdown_pct.toFixed(1)}%` : h.status === "active" ? "Running" : ""}
              </span>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

export default function PropPage() {
  const { user } = useUser();
  const [data, setData] = useState<PropOverview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [picking, setPicking] = useState(false);
  const [leaving, setLeaving] = useState(false);

  const load = () => api.prop().then(setData, (e) => setError(e instanceof Error ? e.message : "Couldn't load your challenges"));
  useEffect(() => { if (user) load(); }, [user]);

  if (user === null) return <SignInPrompt what="practise a prop-firm style challenge" next="/paper/prop" />;
  if (user === undefined) return null;

  const cur = data?.current ?? null;
  const showPicker = data && (!cur || cur.status !== "active" || picking);

  async function leave() {
    try {
      await api.propLeave();
      toast("Back to free practice. Your paper account keeps its balance.");
      setLeaving(false);
      await load();
    } catch (e) {
      toast(e instanceof Error ? e.message : "Couldn't leave the challenge", { tone: "down" });
    }
  }

  return (
    <div className="mx-auto max-w-6xl px-4 py-8">
      <PageHeader icon="trophy" title="Prop challenge"
        subtitle="Practise the evaluation that funded-trader programmes use: hit a profit target without breaking a daily or overall loss limit, over a minimum number of trading days. Virtual money only, and not linked to any prop firm."
        right={cur?.status === "active" ? (
          <Link href="/paper" className="flex items-center gap-1.5 rounded-full bg-gradient-to-b from-gold-hi to-gold px-4 py-1.5 text-sm font-semibold text-black">
            Trade the challenge <Icon name="arrow" className="h-4 w-4" />
          </Link>
        ) : undefined} />

      {error && <p className="mt-6 text-sm text-down">{error}</p>}
      {!data && !error && <div className="mt-6 h-40 animate-pulse rounded-2xl bg-surface" />}

      {cur && (
        <div className="mt-6">
          <RulePanel ch={cur} />
          <div className="mt-3 flex flex-wrap items-center gap-2">
            {cur.status === "active" && !picking && (
              <button onClick={() => setPicking(true)} className="rounded-full border border-border px-4 py-1.5 text-sm transition hover:border-muted">Start a different challenge</button>
            )}
            {leaving ? (
              <span className="quiz-in flex flex-wrap items-center gap-2 text-sm">
                {cur.status === "active" ? "This gives up the challenge. " : ""}Your paper account keeps its balance.
                <button onClick={leave} className="rounded-full bg-down px-4 py-1.5 text-sm font-medium text-black">Leave challenge mode</button>
                <button onClick={() => setLeaving(false)} className="rounded-full border border-border px-3 py-1.5 text-sm">Stay</button>
              </span>
            ) : (
              <button onClick={() => setLeaving(true)} className="rounded-full border border-border px-4 py-1.5 text-sm text-muted transition hover:border-muted hover:text-foreground">
                {cur.status === "active" ? "Leave the challenge" : "Back to free practice"}
              </button>
            )}
          </div>
        </div>
      )}

      {showPicker && (
        <Picker plans={data.plans} maxLev={data.max_leverage} replacing={cur}
          onStarted={() => { setPicking(false); load(); }} />
      )}

      {!cur && data && (
        <section className="mt-8 grid gap-3 sm:grid-cols-3">
          {[
            ["trophy", "Reach the target", "Close trades in profit until the balance reaches the target, with nothing left open."],
            ["risk", "Stay inside the limits", "Equity, open trades included, must stay above the day's floor and the overall floor at every minute. Breaking either ends the challenge."],
            ["calendar", "Trade on enough days", "Open at least one position on the minimum number of days, so a pass shows a process rather than one lucky trade."],
          ].map(([icon, t, d]) => (
            <div key={t} className="rounded-2xl border border-border bg-surface p-4">
              <Icon name={icon} className="h-5 w-5 text-gold" />
              <p className="mt-2 font-medium">{t}</p>
              <p className="mt-1 text-sm text-muted">{d}</p>
            </div>
          ))}
        </section>
      )}

      <History items={(data?.history ?? []).filter((h) => h.id !== cur?.id)} />
    </div>
  );
}
