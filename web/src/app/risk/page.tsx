"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import SignInPrompt from "@/components/SignInPrompt";
import { api, type RiskProfile, type RiskQuestion } from "@/lib/api";
import { useUser } from "@/lib/useUser";

function Result({ p, onRetake }: { p: RiskProfile; onRetake: () => void }) {
  return (
    <div className="rounded-lg border border-border bg-surface p-6">
      <p className="text-sm text-muted">Your risk profile</p>
      <h2 className="mt-1 text-2xl font-semibold text-gold">{p.label}</h2>
      <p className="mt-2 text-sm">{p.summary}</p>
      <div className="mt-5 grid gap-3 sm:grid-cols-3">
        <div className="rounded-md border border-border p-3">
          <p className="text-xs text-muted">Risk per trade</p>
          <p className="mt-1 text-lg font-semibold">up to {p.max_risk_per_trade_pct}%</p>
          <p className="text-xs text-muted">of your account, if the stop loss is hit</p>
        </div>
        <div className="rounded-md border border-border p-3">
          <p className="text-xs text-muted">Drawdown you can live with</p>
          <p className="mt-1 text-lg font-semibold">up to {p.max_drawdown_pct}%</p>
          <p className="text-xs text-muted">fall from the account&apos;s peak</p>
        </div>
        <div className="rounded-md border border-border p-3">
          <p className="text-xs text-muted">Leverage</p>
          <p className="mt-1 text-lg font-semibold">up to {p.max_leverage}x</p>
          <p className="text-xs text-muted">position value compared with your balance</p>
        </div>
      </div>
      <p className="mt-4 text-xs text-muted">
        These are general guidelines for learning, not personal financial advice. Backtests and your trade log will
        be checked against them.
      </p>
      <div className="mt-5 flex gap-3">
        <Link href="/backtest" className="rounded-md bg-gold px-4 py-2 font-medium text-black">Try a backtest</Link>
        <button onClick={onRetake} className="rounded-md border border-border px-4 py-2">Retake the quiz</button>
      </div>
    </div>
  );
}

export default function RiskPage() {
  const { user } = useUser();
  const [questions, setQuestions] = useState<RiskQuestion[]>([]);
  const [answers, setAnswers] = useState<Record<string, number>>({});
  const [profile, setProfile] = useState<RiskProfile | null | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api.riskQuiz().then((q) => setQuestions(q.questions));
  }, []);
  useEffect(() => {
    if (user) api.riskProfile().then(setProfile, () => setProfile(null));
  }, [user]);

  if (user === null) return <SignInPrompt what="find your risk profile" next="/risk" />;
  if (user === undefined || profile === undefined) return null;

  if (profile)
    return (
      <div className="mx-auto max-w-3xl px-4 py-10">
        <Result p={profile} onRetake={() => { setAnswers(profile.answers); setProfile(null); }} />
      </div>
    );

  const done = questions.length > 0 && questions.every((q) => answers[q.key] !== undefined);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    try {
      setProfile(await api.saveRiskProfile(answers));
      window.scrollTo({ top: 0 });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't save your answers");
    }
  }

  return (
    <form onSubmit={submit} className="mx-auto max-w-3xl space-y-6 px-4 py-10">
      <div>
        <h1 className="text-xl font-semibold">What&apos;s your risk appetite?</h1>
        <p className="mt-1 text-sm text-muted">Eight quick questions. There are no right answers, just pick what fits you best.</p>
      </div>
      {questions.map((q, qi) => (
        <fieldset key={q.key} className="rounded-lg border border-border p-4">
          <legend className="px-1 text-sm font-medium">{qi + 1}. {q.text}</legend>
          <div className="mt-2 grid gap-2 sm:grid-cols-2">
            {q.options.map((o, oi) => (
              <label key={o} className={`flex cursor-pointer items-center gap-2 rounded-md border px-3 py-2 text-sm ${answers[q.key] === oi ? "border-gold bg-gold/10" : "border-border hover:bg-surface"}`}>
                <input type="radio" name={q.key} checked={answers[q.key] === oi} onChange={() => setAnswers({ ...answers, [q.key]: oi })} className="accent-[var(--gold)]" />
                {o}
              </label>
            ))}
          </div>
        </fieldset>
      ))}
      {error && <p className="text-sm text-down">{error}</p>}
      <button disabled={!done} className="w-full rounded-md bg-gold py-2.5 font-medium text-black disabled:opacity-50">
        {done ? "See my profile" : `Answer all ${questions.length} questions`}
      </button>
    </form>
  );
}
