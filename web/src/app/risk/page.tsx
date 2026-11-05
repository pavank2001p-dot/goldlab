"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import SignInPrompt from "@/components/SignInPrompt";
import { PageHeader } from "@/components/ui";
import { api, type RiskCategory, type RiskLimits, type RiskProfile, type RiskQuestion } from "@/lib/api";
import { useUser } from "@/lib/useUser";

const ICONS: Record<string, React.ReactNode> = {
  experience: <path d="M4 19V6a2 2 0 0 1 2-2h12v15H6a2 2 0 0 0-2 2Zm0 0a2 2 0 0 1 2-2h12" />,
  goals: <><circle cx="12" cy="12" r="8" /><circle cx="12" cy="12" r="4" /><circle cx="12" cy="12" r="0.5" /></>,
  capacity: <path d="M12 3 4 7v5c0 4.5 3.4 8.3 8 9 4.6-.7 8-4.5 8-9V7l-8-4Z" />,
  behaviour: <path d="M3 12h4l3-7 4 14 3-7h4" />,
  style: <path d="M4 20h16M7 16V9m5 7V5m5 11v-5" />,
};

function Icon({ name, className = "h-4 w-4" }: { name: string; className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden>
      {ICONS[name]}
    </svg>
  );
}

const PROFILE_ORDER = ["conservative", "moderate", "aggressive"] as const;
const ZONE_COLOURS = ["var(--up)", "var(--gold)", "var(--down)"];

// ---------------------------------------------------------------------------
// Quiz
// ---------------------------------------------------------------------------

/** "Best +25%, worst -18%" drawn as a pair of bars around zero. */
function RangeBars({ text }: { text: string }) {
  const nums = [...text.matchAll(/[+-]\d+/g)].map((m) => Number(m[0]));
  if (nums.length !== 2) return null;
  const [best, worst] = nums;
  const scale = 50; // the largest option
  return (
    <div className="mt-2 flex h-2 w-full items-center" aria-hidden>
      <div className="flex h-full w-1/2 justify-end">
        <div className="h-full rounded-l bg-down/80" style={{ width: `${(Math.abs(worst) / scale) * 100}%` }} />
      </div>
      <div className="h-3 w-px bg-muted" />
      <div className="h-full w-1/2">
        <div className="h-full rounded-r bg-up/80" style={{ width: `${(best / scale) * 100}%` }} />
      </div>
    </div>
  );
}

function Quiz({ questions, categories, initial, onDone }: {
  questions: RiskQuestion[];
  categories: Record<string, RiskCategory>;
  initial: Record<string, number>;
  onDone: (p: RiskProfile) => void;
}) {
  const [answers, setAnswers] = useState<Record<string, number>>(initial);
  const [step, setStep] = useState(() => {
    const first = questions.findIndex((q) => answers[q.key] === undefined);
    return first === -1 ? 0 : first;
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const q = questions[step];
  const answered = questions.filter((x) => answers[x.key] !== undefined).length;
  const done = answered === questions.length;
  const last = step === questions.length - 1;
  const catKeys = Object.keys(categories);

  const choose = useCallback((i: number) => {
    setAnswers((a) => ({ ...a, [q.key]: i }));
    if (!last) setTimeout(() => setStep((s) => Math.min(s + 1, questions.length - 1)), 220);
  }, [q.key, last, questions.length]);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
      const k = e.key.toLowerCase();
      const i = "1234".indexOf(k) !== -1 ? "1234".indexOf(k) : "abcd".indexOf(k);
      if (i !== -1 && i < q.options.length) choose(i);
      else if (e.key === "ArrowLeft" && step > 0) setStep(step - 1);
      else if (e.key === "ArrowRight" && answers[q.key] !== undefined && !last) setStep(step + 1);
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [choose, q, step, last, answers]);

  async function submit() {
    setBusy(true);
    setError(null);
    try {
      onDone(await api.saveRiskProfile(answers));
      window.scrollTo({ top: 0 });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't save your answers");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mx-auto max-w-2xl px-4 py-8">
      <PageHeader icon="risk" title="What's your risk appetite?"
        subtitle={`${questions.length} quick questions in ${catKeys.length} parts. There are no right answers, just pick what fits you best.`} />

      {/* Sections */}
      <div className="mt-6 grid grid-cols-5 gap-1.5">
        {catKeys.map((key) => {
          const qs = questions.map((x, i) => ({ ...x, i })).filter((x) => x.category === key);
          const n = qs.filter((x) => answers[x.key] !== undefined).length;
          const current = q.category === key;
          return (
            <button key={key} type="button" onClick={() => setStep(qs.find((x) => answers[x.key] === undefined)?.i ?? qs[0].i)}
              className={`group text-left ${current ? "text-foreground" : "text-muted hover:text-foreground"}`}>
              <div className="h-1.5 overflow-hidden rounded-full bg-border">
                <div className="h-full rounded-full bg-gold transition-all duration-300" style={{ width: `${(n / qs.length) * 100}%` }} />
              </div>
              <div className="mt-1.5 flex items-center gap-1 text-[11px] sm:text-xs">
                <Icon name={key} className={`hidden h-3.5 w-3.5 shrink-0 sm:block ${current ? "text-gold" : ""}`} />
                <span className="truncate">{categories[key].label}</span>
              </div>
            </button>
          );
        })}
      </div>

      {/* Question */}
      <div key={q.key} className="quiz-card mt-6 rounded-xl border border-border bg-surface p-5 sm:p-6">
        <div className="flex items-center justify-between text-xs text-muted">
          <span className="flex items-center gap-1.5 text-gold">
            <Icon name={q.category} /> {categories[q.category]?.label}
          </span>
          <span className="tabular-nums">Question {step + 1} of {questions.length}</span>
        </div>
        <h2 className="mt-3 text-lg font-medium leading-snug sm:text-xl">{q.text}</h2>
        <div className="mt-5 grid gap-2.5">
          {q.options.map((o, i) => {
            const on = answers[q.key] === i;
            return (
              <button key={o} type="button" onClick={() => choose(i)} aria-pressed={on}
                className={`flex items-center gap-3 rounded-lg border px-3.5 py-3 text-left text-sm transition-colors ${
                  on ? "border-gold bg-gold/10" : "border-border hover:border-muted hover:bg-background"
                }`}>
                <span className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-md border text-xs font-semibold ${
                  on ? "border-gold bg-gold text-black" : "border-border text-muted"
                }`}>
                  {"ABCD"[i]}
                </span>
                <span className="min-w-0 flex-1">
                  {o}
                  {q.visual === "range" && <RangeBars text={o} />}
                </span>
              </button>
            );
          })}
        </div>
        {q.visual === "range" && (
          <p className="mt-3 flex gap-4 text-xs text-muted">
            <span className="flex items-center gap-1.5"><span className="h-2 w-3 rounded-sm bg-down/80" /> Worst year</span>
            <span className="flex items-center gap-1.5"><span className="h-2 w-3 rounded-sm bg-up/80" /> Best year</span>
          </p>
        )}
      </div>

      <div className="mt-4 flex items-center justify-between gap-3">
        <button type="button" onClick={() => setStep(step - 1)} disabled={step === 0}
          className="rounded-md border border-border px-4 py-2 text-sm disabled:opacity-40">
          Back
        </button>
        <p className="hidden text-xs text-muted sm:block">Tip: press A to D to answer</p>
        {last || done ? (
          <button type="button" onClick={submit} disabled={!done || busy}
            className="rounded-md bg-gold px-5 py-2 text-sm font-medium text-black disabled:opacity-50">
            {busy ? "Saving…" : done ? "See my profile" : `${questions.length - answered} left to answer`}
          </button>
        ) : (
          <button type="button" onClick={() => setStep(step + 1)} disabled={answers[q.key] === undefined}
            className="rounded-md border border-border px-4 py-2 text-sm disabled:opacity-40">
            Next
          </button>
        )}
      </div>
      {error && <p className="mt-3 text-sm text-down">{error}</p>}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Result
// ---------------------------------------------------------------------------

/** Half-circle gauge split into the three profile zones (40% and 70% boundaries). */
function Gauge({ pct, profile }: { pct: number; profile: string }) {
  const r = 80, cx = 100, cy = 95;
  const pt = (f: number, rad = r) => {
    const a = Math.PI * (1 - f);
    return [cx + rad * Math.cos(a), cy - rad * Math.sin(a)];
  };
  const arc = (a: number, b: number) => {
    const [x1, y1] = pt(a), [x2, y2] = pt(b);
    return `M ${x1} ${y1} A ${r} ${r} 0 0 1 ${x2} ${y2}`;
  };
  const zones: [number, number][] = [[0, 0.4], [0.4, 0.7], [0.7, 1]];
  const active = PROFILE_ORDER.indexOf(profile as (typeof PROFILE_ORDER)[number]);
  const f = Math.min(Math.max(pct, 0.01), 0.99);
  const [nx, ny] = pt(f, r - 22);
  return (
    <svg viewBox="0 0 200 110" className="w-full max-w-[260px]" role="img" aria-label={`Score ${Math.round(pct * 100)} out of 100`}>
      {zones.map(([a, b], i) => (
        <path key={i} d={arc(a + 0.006, b - 0.006)} fill="none" stroke={ZONE_COLOURS[i]} strokeWidth={14}
          strokeOpacity={i === active ? 1 : 0.25} />
      ))}
      <line x1={cx} y1={cy} x2={nx} y2={ny} stroke="var(--foreground)" strokeWidth={3} strokeLinecap="round" className="gauge-needle"
        style={{ transformOrigin: `${cx}px ${cy}px` }} />
      <circle cx={cx} cy={cy} r={6} fill="var(--foreground)" />
      <text x={pt(0.02, r + 2)[0]} y={cy + 13} fontSize={9} fill="var(--muted)" textAnchor="start">Cautious</text>
      <text x={pt(0.98, r + 2)[0]} y={cy + 13} fontSize={9} fill="var(--muted)" textAnchor="end">Bold</text>
    </svg>
  );
}

/** Where this profile's limit sits among all three profiles' limits. */
function LimitScale({ field, profiles, profile }: { field: keyof RiskLimits; profiles: Record<string, RiskLimits>; profile: string }) {
  return (
    <div className="mt-3 grid grid-cols-3 gap-1">
      {PROFILE_ORDER.map((k, i) => (
        <div key={k}>
          <div className="h-1.5 rounded-full" style={{ background: ZONE_COLOURS[i], opacity: k === profile ? 1 : 0.2 }} />
          <p className={`mt-1 text-center text-[10px] tabular-nums ${k === profile ? "text-foreground" : "text-muted"}`}>
            {String(profiles[k]?.[field] ?? "")}{field === "max_leverage" ? "x" : "%"}
          </p>
        </div>
      ))}
    </div>
  );
}

function barColour(pct: number) {
  return pct < 40 ? "var(--up)" : pct < 70 ? "var(--gold)" : "var(--down)";
}

function Result({ p, profiles, onRetake }: { p: RiskProfile; profiles: Record<string, RiskLimits>; onRetake: () => void }) {
  const pct = p.max_score ? p.score / p.max_score : 0;
  const idx = PROFILE_ORDER.indexOf(p.profile);
  const account = 10_000;
  const riskUsd = (account * p.max_risk_per_trade_pct) / 100;
  const limits = [
    { field: "max_risk_per_trade_pct" as const, title: "Risk per trade", value: `${p.max_risk_per_trade_pct}%`, note: "of your account lost if a stop loss is hit" },
    { field: "max_drawdown_pct" as const, title: "Drawdown you can live with", value: `${p.max_drawdown_pct}%`, note: "fall from the account's peak" },
    { field: "max_leverage" as const, title: "Leverage", value: `${p.max_leverage}x`, note: "position value compared with your balance" },
  ];

  return (
    <div className="mx-auto max-w-4xl space-y-5 px-4 py-8">
      {!p.complete && (
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-gold/40 bg-gold/10 px-4 py-3 text-sm">
          <span>We&apos;ve added new questions to the quiz. Retake it to make your profile more accurate.</span>
          <button onClick={onRetake} className="rounded-md bg-gold px-3 py-1.5 text-xs font-medium text-black">Answer the new questions</button>
        </div>
      )}

      <section className="grid items-center gap-6 rounded-xl border border-border bg-surface p-6 sm:grid-cols-[260px_1fr]">
        <div className="flex flex-col items-center">
          <Gauge pct={pct} profile={p.profile} />
          <p className="-mt-1 text-xs tabular-nums text-muted">Score {p.score} of {p.max_score}</p>
        </div>
        <div>
          <p className="text-sm text-muted">Your risk profile</p>
          <h2 className="mt-1 text-3xl font-semibold" style={{ color: ZONE_COLOURS[idx] }}>{p.label}</h2>
          <p className="mt-2 text-sm leading-relaxed">{p.summary}</p>
          <div className="mt-4 flex flex-wrap gap-2">
            <Link href="/backtest" className="rounded-md bg-gold px-4 py-2 text-sm font-medium text-black">Try a backtest</Link>
            <button onClick={onRetake} className="rounded-md border border-border px-4 py-2 text-sm">Retake the quiz</button>
          </div>
        </div>
      </section>

      <section>
        <h3 className="mb-2 text-sm font-medium">Your limits</h3>
        <div className="grid gap-3 sm:grid-cols-3">
          {limits.map((l) => (
            <div key={l.field} className="rounded-xl border border-border bg-surface p-4">
              <p className="text-xs text-muted">{l.title}</p>
              <p className="mt-1 text-2xl font-semibold tabular-nums">up to {l.value}</p>
              <p className="text-xs text-muted">{l.note}</p>
              <LimitScale field={l.field} profiles={profiles} profile={p.profile} />
            </div>
          ))}
        </div>
      </section>

      <div className="grid gap-5 lg:grid-cols-[1fr_320px]">
        {p.breakdown.length > 0 && (
          <section className="rounded-xl border border-border bg-surface p-5">
            <h3 className="text-sm font-medium">What shaped your result</h3>
            <p className="mt-0.5 text-xs text-muted">How cautious or bold your answers were in each part of the quiz.</p>
            <div className="mt-4 space-y-4">
              {p.breakdown.map((b) => (
                <div key={b.key}>
                  <div className="flex items-center justify-between text-sm">
                    <span className="flex items-center gap-2"><Icon name={b.key} className="h-4 w-4 text-muted" /> {b.label}</span>
                    <span className="text-xs tabular-nums text-muted">{b.pct < 40 ? "Cautious" : b.pct < 70 ? "Balanced" : "Bold"}</span>
                  </div>
                  <div className="mt-1.5 h-2 overflow-hidden rounded-full bg-border">
                    <div className="bar-grow h-full rounded-full" style={{ width: `${Math.max(b.pct, 3)}%`, background: barColour(b.pct) }} />
                  </div>
                  <p className="mt-1 text-xs text-muted">{b.summary}</p>
                </div>
              ))}
            </div>
          </section>
        )}

        <section className="rounded-xl border border-border bg-surface p-5">
          <h3 className="text-sm font-medium">In practice</h3>
          <p className="mt-0.5 text-xs text-muted">On a ${account.toLocaleString()} account:</p>
          <ul className="mt-4 space-y-3 text-sm">
            <li className="flex gap-3">
              <span className="mt-1.5 h-2 w-2 shrink-0 rounded-full bg-gold" />
              <span>Lose at most <b className="tabular-nums">${riskUsd.toLocaleString()}</b> on any one trade. With a $20 stop on gold that is about <b className="tabular-nums">{(riskUsd / 20).toFixed(1)} oz</b>.</span>
            </li>
            <li className="flex gap-3">
              <span className="mt-1.5 h-2 w-2 shrink-0 rounded-full bg-gold" />
              <span>Step back and review if the account falls below <b className="tabular-nums">${(account * (1 - p.max_drawdown_pct / 100)).toLocaleString()}</b>.</span>
            </li>
            <li className="flex gap-3">
              <span className="mt-1.5 h-2 w-2 shrink-0 rounded-full bg-gold" />
              <span>Keep open positions under <b className="tabular-nums">${(account * p.max_leverage).toLocaleString()}</b> of gold in total.</span>
            </li>
          </ul>
        </section>
      </div>

      <p className="text-xs text-muted">
        These are general guidelines for learning, not personal financial advice. Your backtests and trade log are checked against them.
      </p>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export default function RiskPage() {
  const { user } = useUser();
  const [quiz, setQuiz] = useState<{ questions: RiskQuestion[]; categories: Record<string, RiskCategory>; profiles: Record<string, RiskLimits> } | null>(null);
  const [profile, setProfile] = useState<RiskProfile | null | undefined>(undefined);
  const [retake, setRetake] = useState<Record<string, number> | null>(null);

  useEffect(() => {
    api.riskQuiz().then(setQuiz);
  }, []);
  useEffect(() => {
    if (user) api.riskProfile().then(setProfile, () => setProfile(null));
  }, [user]);

  if (user === null) return <SignInPrompt what="find your risk profile" next="/risk" />;
  if (user === undefined || profile === undefined || !quiz) return null;

  if (profile && !retake)
    return <Result p={profile} profiles={quiz.profiles} onRetake={() => setRetake(profile.answers)} />;

  return (
    <Quiz
      questions={quiz.questions}
      categories={quiz.categories}
      initial={retake ?? {}}
      onDone={(p) => { setProfile(p); setRetake(null); }}
    />
  );
}
