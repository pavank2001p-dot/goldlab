"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import ReplayPlayer from "@/components/practice/ReplayPlayer";
import ReplaySummary, { summarize } from "@/components/practice/ReplaySummary";
import { Icon } from "@/components/ui";
import { api, type Lesson, type Replay, type ReplaySettled } from "@/lib/api";
import { useUser } from "@/lib/useUser";

const fmtDay = (d: string) =>
  new Date(`${d}T00:00:00Z`).toLocaleDateString("en-GB", { timeZone: "UTC", weekday: "long", day: "numeric", month: "long", year: "numeric" });

export default function LessonPage() {
  const { id } = useParams<{ id: string }>();
  const { user } = useUser();
  const [lesson, setLesson] = useState<Lesson | null>(null);
  const [replay, setReplay] = useState<Replay | null>(null);
  const [done, setDone] = useState<ReplaySettled[] | null>(null);
  const [saved, setSaved] = useState(false);
  const [round, setRound] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setLesson(null); setReplay(null); setDone(null); setSaved(false); setError(null);
    api.lesson(id).then(setLesson, (e) => setError(e instanceof Error ? e.message : "Couldn't load this lesson"));
  }, [id]);

  async function start() {
    if (!lesson) return;
    setBusy(true);
    setError(null);
    try {
      setReplay(await api.replay({ tf: "1h", day: lesson.day }));
      setRound((r) => r + 1);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't load that week");
    } finally {
      setBusy(false);
    }
  }

  const finish = useCallback(async (_: unknown, d: ReplaySettled[]) => {
    setDone(d);
    if (!user || !replay) return;
    const s = summarize(d, replay.balance);
    try {
      await api.completeLesson(id, { return_pct: Math.max(-100, s.return_pct), trades: s.trades });
      setSaved(true);
    } catch {}
  }, [user, replay, id]);

  if (error && !lesson) return <p role="alert" className="mx-auto max-w-3xl px-4 py-16 text-center text-sm text-down">{error}</p>;
  if (!lesson) return <div className="mx-auto max-w-3xl px-4 py-8"><div className="h-96 animate-pulse rounded-2xl bg-surface-2" /></div>;

  return (
    <div className={`mx-auto space-y-5 px-4 py-8 ${replay ? "max-w-6xl" : "max-w-3xl"}`}>
      <Link href="/learn" className="inline-flex items-center gap-1 text-sm text-muted hover:text-gold">
        <Icon name="arrow" className="h-4 w-4 rotate-180" /> All lessons
      </Link>

      <article className="card relative overflow-hidden p-6">
        <div aria-hidden className="pointer-events-none absolute -right-16 -top-16 h-48 w-48 rounded-full bg-gold/15 blur-3xl" />
        <p className="text-xs uppercase tracking-wider text-gold">{lesson.year} · {lesson.minutes} min</p>
        <h1 className="mt-1 text-2xl font-bold sm:text-3xl">{lesson.title}</h1>
        <p className="mt-1 text-muted">{lesson.summary}</p>
        {!replay && (
          <div className="mt-5 space-y-3 leading-relaxed">
            {lesson.body.map((p) => <p key={p.slice(0, 24)}>{p}</p>)}
          </div>
        )}
        <div className="mt-5 rounded-xl border border-border bg-background/50 p-4">
          <p className="text-sm font-medium">What to watch in the replay</p>
          <ul className="mt-2 space-y-1.5 text-sm">
            {lesson.watch.map((w) => <li key={w} className="flex gap-2"><Icon name="check" className="mt-0.5 h-4 w-4 shrink-0 text-gold" />{w}</li>)}
          </ul>
        </div>
        {!replay && (
          <div className="mt-6 flex flex-wrap items-center gap-3">
            <button type="button" onClick={start} disabled={busy}
              className="rounded-full bg-gradient-to-b from-gold-hi to-gold px-6 py-2.5 text-sm font-semibold text-black shadow-[0_10px_30px_-14px_var(--gold)] disabled:opacity-50">
              {busy ? "Loading the week…" : "Trade this week"}
            </button>
            <p className="text-xs text-muted">Hourly candles from {fmtDay(lesson.day)}, with $10,000 of virtual money.</p>
          </div>
        )}
        {error && <p role="alert" className="mt-3 text-sm text-down">{error}</p>}
      </article>

      {replay && (
        <div className="space-y-4">
          <ReplayPlayer key={round} bars={replay.bars} context={replay.context} balance={replay.balance} leverage={replay.leverage} onFinish={finish} />
          {done && (
            <ReplaySummary done={done} balance={replay.balance}>
              <p className="mt-4 rounded-lg bg-gold/10 px-3 py-2 text-sm"><span className="font-medium text-gold">The lesson: </span>{lesson.takeaway}</p>
              <p className="mt-2 text-xs text-muted">
                {user ? (saved ? "Lesson finished and saved to your account." : "Saving your progress…")
                  : <><Link href={`/signup?next=/learn/${lesson.id}`} className="text-gold hover:underline">Sign up</Link> to keep track of the lessons you finish.</>}
              </p>
              <div className="mt-4 flex flex-wrap gap-2">
                <button type="button" onClick={() => { setDone(null); setRound((r) => r + 1); }}
                  className="rounded-full border border-border px-4 py-1.5 text-sm hover:border-gold/40">Trade it again</button>
                {lesson.next ? (
                  <Link href={`/learn/${lesson.next}`}
                    className="flex items-center gap-1 rounded-full bg-gradient-to-b from-gold-hi to-gold px-4 py-1.5 text-sm font-semibold text-black">
                    Next lesson <Icon name="arrow" className="h-4 w-4" />
                  </Link>
                ) : (
                  <Link href="/paper/challenge" className="rounded-full bg-gradient-to-b from-gold-hi to-gold px-4 py-1.5 text-sm font-semibold text-black">
                    Try the weekly challenge
                  </Link>
                )}
              </div>
            </ReplaySummary>
          )}
        </div>
      )}
      <p className="text-[11px] text-muted">Practice with virtual money on past prices. This lesson describes what happened; it doesn&apos;t say what gold will do next, and nothing here is advice.</p>
    </div>
  );
}
