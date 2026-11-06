"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import SignInPrompt from "@/components/SignInPrompt";
import { Chips, Empty, Icon, PageHeader } from "@/components/ui";
import { api, fmtPct, type BacktestParams, type FitCheck, type Plan, type PlanInput, type PlanOptions, type PlanResult, type PlanStats } from "@/lib/api";
import { useUser } from "@/lib/useUser";

const input = "w-full rounded-md border border-border bg-background px-3 py-1.5 outline-none focus:border-gold";
const VERDICT: Record<FitCheck["level"], { label: string; cls: string }> = {
  fits: { label: "Fits", cls: "bg-up/15 text-up" },
  close: { label: "Slightly over", cls: "bg-gold/15 text-gold" },
  over: { label: "Over", cls: "bg-down/15 text-down" },
};
const PROFILES = ["conservative", "moderate", "aggressive"] as const;

function Badge({ level }: { level: FitCheck["level"] }) {
  const v = VERDICT[level];
  return <span className={`rounded-full px-2 py-0.5 text-[11px] font-medium ${v.cls}`}>{v.label}</span>;
}

function Label({ children }: { children: React.ReactNode }) {
  return <span className="mb-1.5 block text-sm text-muted">{children}</span>;
}

const ret = (v: number | null) => <span className={(v ?? 0) >= 0 ? "text-up" : "text-down"}>{v == null ? "–" : `${v > 0 ? "+" : ""}${v.toFixed(1)}%`}</span>;
const dd = (v: number | null) => <span className="text-down">{v == null ? "–" : `${v.toFixed(1)}%`}</span>;
const day = (t: number) => new Date(t * 1000).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });
const range = (p: { start: number; end: number }) => `${day(p.start)} to ${day(p.end)}`;

function heldUp(r: PlanResult) {
  const o = r.out_of_sample;
  if (r.out_of_sample_fit !== "fits") return { ok: false, text: "Broke your limits on the unseen years" };
  if ((o.cagr_pct ?? 0) <= 0) return { ok: false, text: "Lost money on the unseen years" };
  return { ok: true, text: "Held up on the unseen years" };
}

function backtestLink(r: PlanResult, plan: Plan, input: PlanInput): string {
  const p: BacktestParams = {
    strategy: r.strategy, params: r.params, tf: plan.tf,
    start: new Date(plan.periods.in_sample.start * 1000).toISOString().slice(0, 10), end: null,
    direction: input.direction, capital: input.capital, units: 1, spread: 0.3, swap_long: -0.25, swap_short: 0.05,
    stop_loss_pct: r.stop_loss_pct, take_profit_pct: null, size_pct: r.size_pct,
  };
  return `/backtest?plan=${encodeURIComponent(JSON.stringify(p))}`;
}

function agentLink(r: PlanResult, plan: Plan, input: PlanInput): string {
  const c = { strategy: r.strategy, params: r.params, tf: plan.tf, direction: input.direction, stop_loss_pct: r.stop_loss_pct,
    size_pct: r.size_pct, years: plan.tf === "1h" ? Math.min(plan.years, 2) : Math.min(plan.years, 20) };
  return `/paper/agent?plan=${encodeURIComponent(JSON.stringify(c))}`;
}

function StatsCol({ title, period, s, fit }: { title: string; period: string; s: PlanStats; fit: FitCheck["level"] }) {
  return (
    <div className="rounded-lg bg-background p-3">
      <div className="flex items-center justify-between gap-2">
        <span className="text-xs font-medium">{title}</span>
        <Badge level={fit} />
      </div>
      <p className="text-[11px] text-muted">{period}</p>
      <dl className="mt-2 grid grid-cols-2 gap-x-3 gap-y-1 text-sm tabular-nums">
        <dt className="text-muted">Per year</dt><dd className="text-right">{ret(s.cagr_pct)}</dd>
        <dt className="text-muted">Largest fall</dt><dd className="text-right">{dd(s.max_drawdown_pct)}</dd>
        <dt className="text-muted">Trades</dt><dd className="text-right">{s.trades}</dd>
        <dt className="text-muted">Win rate</dt><dd className="text-right">{fmtPct(s.win_rate_pct)}</dd>
      </dl>
    </div>
  );
}

function Pick({ r, rank, plan, input }: { r: PlanResult; rank: number; plan: Plan; input: PlanInput }) {
  const h = heldUp(r);
  const oz = (input.capital * r.size_pct) / 100 / plan.last_price;
  return (
    <article className="rounded-xl border border-border bg-surface p-4">
      <div className="flex items-start gap-3">
        <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-gold/15 font-semibold text-gold">{rank}</span>
        <div className="min-w-0 flex-1">
          <h3 className="font-medium">{r.label}</h3>
          <p className="text-xs text-muted">{r.kind_label}</p>
        </div>
      </div>
      <p className="mt-3 text-sm text-muted">{r.summary}</p>
      <ul className="mt-3 flex flex-wrap gap-1.5 text-xs">
        {Object.entries(r.params).map(([k, v]) => {
          const l = r.param_labels[k] ?? k;
          return (
            <li key={k} className="rounded-md border border-border px-2 py-0.5">
              {l.includes("(1 = yes)") ? `${l.replace(" (1 = yes)", "")}: ${v ? "yes" : "no"}` : `${l}: ${v}`}
            </li>
          );
        })}
        <li className="rounded-md border border-border px-2 py-0.5">Stop loss {r.stop_loss_pct}%</li>
      </ul>
      <p className="mt-3 text-sm">
        Size each trade at <b className="tabular-nums">{r.size_pct.toFixed(0)}%</b> of the account
        <span className="text-muted"> ({(r.size_pct / 100).toFixed(2)}x, about {oz.toFixed(2)} oz on ${input.capital.toLocaleString()} today)</span>,
        so a stop-out costs about {plan.limits.max_risk_per_trade_pct}% or less.
      </p>
      <div className="mt-3 grid gap-2 sm:grid-cols-2">
        <StatsCol title="Tuning years" period={range(plan.periods.in_sample)} s={r.in_sample} fit={r.in_sample_fit} />
        <StatsCol title="Unseen years" period={range(plan.periods.out_of_sample)} s={r.out_of_sample} fit={r.out_of_sample_fit} />
      </div>
      <div className="mt-3 flex flex-wrap items-center justify-between gap-2">
        <span className={`flex items-center gap-1.5 text-sm ${h.ok ? "text-up" : "text-gold"}`}>
          <Icon name={h.ok ? "check" : "bolt"} className="h-4 w-4" />{h.text}
        </span>
        <div className="flex gap-2">
          <Link href={backtestLink(r, plan, input)} className="rounded-md border border-border px-3 py-1.5 text-sm hover:border-gold hover:text-gold">
            Open in backtester
          </Link>
          <Link href={agentLink(r, plan, input)} className="rounded-md border border-gold px-3 py-1.5 text-sm text-gold hover:bg-gold/10">
            Run as agent
          </Link>
        </div>
      </div>
    </article>
  );
}

export default function StrategiesPage() {
  const { user } = useUser();
  const [opts, setOpts] = useState<PlanOptions | null>(null);
  const [form, setForm] = useState<PlanInput>({ tf: "1d", years: 10, style: "any", direction: "both", capital: 10000 });
  const [plan, setPlan] = useState<Plan | null>(null);
  const [asked, setAsked] = useState<PlanInput | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!user) return;
    api.planOptions().then((o) => {
      setOpts(o);
      const d = o.defaults;
      setForm((f) => ({ ...f, profile: d.profile ?? "moderate", tf: d.tf, years: d.tf === "1h" ? 2 : 10, max_leverage: d.max_leverage }));
    });
  }, [user]);

  if (user === null) return <SignInPrompt what="find strategies that fit your risk profile" next="/strategies" />;
  if (!user || !opts) return null;

  const set = (patch: Partial<PlanInput>) => setForm({ ...form, ...patch });
  const limits = opts.profiles[form.profile ?? "moderate"];
  const levChoices = [0.5, 1, 2, 3, 5, 10].filter((x) => x <= limits.max_leverage);

  async function find(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const q = { ...form, max_leverage: form.max_leverage && form.max_leverage <= limits.max_leverage ? form.max_leverage : null };
      setPlan(await api.plan(q));
      setAsked(q);
      if (window.innerWidth < 1024) setTimeout(() => document.getElementById("results")?.scrollIntoView({ behavior: "smooth" }), 50);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't find strategies");
    } finally {
      setBusy(false);
    }
  }

  const picks = plan ? plan.results.filter((r) => r.qualifies).slice(0, 3) : [];
  const rest = plan ? plan.results.filter((r) => !picks.includes(r)) : [];

  return (
    <div className="mx-auto grid max-w-6xl gap-6 px-4 py-8 lg:grid-cols-[320px_1fr]">
      <form onSubmit={find} className="space-y-5">
        <PageHeader icon="trophy" title="Strategy finder" subtitle="Strategies tuned to your risk limits on gold's history" />

        <div>
          <Label>Risk profile</Label>
          <Chips value={form.profile ?? "moderate"} onChange={(p) => set({ profile: p })}
            options={PROFILES.map((p) => ({ key: p, label: opts.profiles[p].label }))} />
          <p className="mt-1.5 text-xs text-muted">
            {opts.defaults.profile ? (
              <>Your <Link href="/risk" className="underline">risk quiz</Link> says {opts.profiles[opts.defaults.profile].label.toLowerCase()}. </>
            ) : (
              <><Link href="/risk" className="text-gold underline">Take the risk quiz</Link> to set this for you. </>
            )}
            Limits: {limits.max_risk_per_trade_pct}% risk per trade, {limits.max_drawdown_pct}% largest fall, {limits.max_leverage}x leverage.
          </p>
        </div>

        <div className="grid grid-cols-2 gap-3">
          <label className="block text-sm">
            <Label>Candles</Label>
            <select className={input} value={form.tf} onChange={(e) => {
              const tf = e.target.value as PlanInput["tf"];
              set({ tf, years: opts.years[tf].includes(form.years) ? form.years : opts.years[tf].at(-1)! });
            }}>
              <option value="1d">Daily</option>
              <option value="1h">Hourly</option>
            </select>
            <span className="mt-1 block text-xs text-muted">{form.tf === "1d" ? "Trades last days to weeks" : "Trades last hours"}</span>
          </label>
          <label className="block text-sm">
            <Label>History</Label>
            <select className={input} value={form.years} onChange={(e) => set({ years: Number(e.target.value) })}>
              {opts.years[form.tf].map((y) => <option key={y} value={y}>Last {y} year{y > 1 ? "s" : ""}</option>)}
            </select>
          </label>
        </div>

        <div>
          <Label>Style</Label>
          <Chips value={form.style} onChange={(s) => set({ style: s })} options={[
            { key: "any", label: "Any" }, { key: "trend", label: "Trend following" }, { key: "reversion", label: "Mean reversion" },
          ]} />
        </div>
        <div>
          <Label>Trades</Label>
          <Chips value={form.direction} onChange={(d) => set({ direction: d })} options={[
            { key: "both", label: "Long and short" }, { key: "long_only", label: "Long only" },
          ]} />
        </div>

        <div className="grid grid-cols-2 gap-3">
          <label className="block text-sm">
            <Label>Account size ($)</Label>
            <input type="number" min={1} className={input} value={form.capital}
              onChange={(e) => set({ capital: Number(e.target.value) || 10000 })} />
          </label>
          <label className="block text-sm">
            <Label>Most leverage</Label>
            <select className={input} value={form.max_leverage ?? limits.max_leverage}
              onChange={(e) => set({ max_leverage: Number(e.target.value) })}>
              {levChoices.map((x) => <option key={x} value={x}>{x}x</option>)}
            </select>
          </label>
        </div>

        {error && <p className="text-sm text-down">{error}</p>}
        <button disabled={busy} className="w-full rounded-md bg-gold py-2 font-medium text-black shadow-[0_8px_30px_-12px_var(--gold)] transition hover:-translate-y-0.5 disabled:opacity-60">
          {busy ? "Testing strategies…" : "Find strategies"}
        </button>
        <p className="text-xs leading-relaxed text-muted">
          Each strategy is tried with a few settings and stop distances, sized so a stop-out costs no more than your
          risk-per-trade limit. Settings are picked on the first 70% of the years and then run, unchanged, on the last
          30%. Past results don&apos;t predict future ones, and none of this is advice to trade.
        </p>
      </form>

      <section id="results" className="min-w-0 space-y-6">
        {!plan || !asked ? (
          <Empty icon="trophy" title="No search yet">
            Pick your profile and preferences, then press Find strategies to see which ones stayed inside your limits on real gold prices.
          </Empty>
        ) : (
          <>
            <div className="rounded-xl border border-border bg-surface p-4 text-sm">
              <p>
                Tried <b>{plan.tried}</b> combinations on {plan.tf === "1h" ? "hourly" : "daily"} candles for a{" "}
                <b>{plan.profile_label.toLowerCase()}</b> profile, up to {plan.max_leverage}x leverage.
              </p>
              <p className="mt-1 text-muted">
                Tuned on {range(plan.periods.in_sample)}, then checked on {range(plan.periods.out_of_sample)}, which the tuning never saw.
              </p>
            </div>

            {picks.length ? (
              <div>
                <h2 className="mb-3 font-medium">Best fits for your limits</h2>
                <div className="space-y-4">
                  {picks.map((r, i) => <Pick key={r.strategy} r={r} rank={i + 1} plan={plan} input={asked} />)}
                </div>
              </div>
            ) : (
              <Empty icon="risk" title="Nothing stayed inside your limits and made money">
                On these years no strategy both made money and kept inside your limits. Try more history, another style,
                or daily candles.
              </Empty>
            )}

            <div>
              <h2 className="mb-2 font-medium">Every strategy tried</h2>
              <div className="overflow-x-auto rounded-xl border border-border">
                <table className="w-full min-w-[620px] text-sm tabular-nums">
                  <thead className="bg-surface text-left text-xs text-muted">
                    <tr>
                      <th className="px-3 py-2">Strategy</th>
                      <th className="px-3 py-2 text-right">Size</th>
                      <th className="px-3 py-2 text-right">Per year (tuning)</th>
                      <th className="px-3 py-2 text-right">Fall</th>
                      <th className="px-3 py-2 text-right">Per year (unseen)</th>
                      <th className="px-3 py-2 text-right">Fall</th>
                      <th className="px-3 py-2">Unseen fit</th>
                    </tr>
                  </thead>
                  <tbody>
                    {[...picks, ...rest].map((r) => (
                      <tr key={r.strategy} className="border-t border-border">
                        <td className="px-3 py-1.5">
                          <Link href={backtestLink(r, plan, asked)} className="hover:text-gold">{r.label}</Link>
                          {!r.qualifies && <span className="ml-1.5 text-xs text-muted">(didn&apos;t qualify)</span>}
                        </td>
                        <td className="px-3 py-1.5 text-right">{r.size_pct.toFixed(0)}%</td>
                        <td className="px-3 py-1.5 text-right">{ret(r.in_sample.cagr_pct)}</td>
                        <td className="px-3 py-1.5 text-right">{dd(r.in_sample.max_drawdown_pct)}</td>
                        <td className="px-3 py-1.5 text-right">{ret(r.out_of_sample.cagr_pct)}</td>
                        <td className="px-3 py-1.5 text-right">{dd(r.out_of_sample.max_drawdown_pct)}</td>
                        <td className="px-3 py-1.5"><Badge level={r.out_of_sample_fit} /></td>
                      </tr>
                    ))}
                    <tr className="border-t border-border bg-surface/60">
                      <td className="px-3 py-1.5 text-muted">Owning gold, no leverage</td>
                      <td className="px-3 py-1.5 text-right">100%</td>
                      <td className="px-3 py-1.5 text-right">{ret(plan.benchmark.in_sample.cagr_pct)}</td>
                      <td className="px-3 py-1.5 text-right">{dd(plan.benchmark.in_sample.max_drawdown_pct)}</td>
                      <td className="px-3 py-1.5 text-right">{ret(plan.benchmark.out_of_sample.cagr_pct)}</td>
                      <td className="px-3 py-1.5 text-right">{dd(plan.benchmark.out_of_sample.max_drawdown_pct)}</td>
                      <td className="px-3 py-1.5"><Badge level={plan.benchmark.out_of_sample_fit} /></td>
                    </tr>
                  </tbody>
                </table>
              </div>
              <p className="mt-2 text-xs text-muted">
                Didn&apos;t qualify means it lost money, broke a limit, or made fewer than 5 trades in the tuning years.
                Owning gold here is a broker position held throughout, so it pays the same overnight costs as the strategies.
              </p>
            </div>
          </>
        )}
      </section>
    </div>
  );
}
