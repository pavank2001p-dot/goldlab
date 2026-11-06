"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { Icon, PageHeader } from "@/components/ui";
import { api, type LessonProgress, type LessonSummary } from "@/lib/api";
import { useUser } from "@/lib/useUser";

export default function LearnPage() {
  const { user } = useUser();
  const [lessons, setLessons] = useState<LessonSummary[] | null>(null);
  const [progress, setProgress] = useState<LessonProgress>({});
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api.lessons().then(setLessons, (e) => setError(e instanceof Error ? e.message : "Couldn't load the lessons"));
  }, []);
  useEffect(() => {
    if (user) api.lessonProgress().then(setProgress, () => {});
  }, [user]);

  const done = lessons?.filter((l) => progress[l.id]).length ?? 0;
  const nextUp = lessons?.find((l) => !progress[l.id]);

  return (
    <div className="mx-auto max-w-3xl space-y-5 px-4 py-8">
      <PageHeader icon="book" title="Lessons"
        subtitle="Short stories from gold's history. Read what happened, then trade that week hour by hour with virtual money." />

      {lessons && (
        <div className="card flex flex-wrap items-center gap-3 p-4">
          <div className="min-w-0 flex-1">
            <p className="text-sm font-medium">{done === lessons.length ? "You've finished every lesson" : `${done} of ${lessons.length} finished`}</p>
            <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-border">
              <div className="h-full rounded-full bg-gradient-to-r from-gold to-gold-hi transition-[width]" style={{ width: `${(done / lessons.length) * 100}%` }} />
            </div>
            {user === null && <p className="mt-2 text-xs text-muted"><Link href="/login?next=/learn" className="text-gold hover:underline">Log in</Link> to keep your progress.</p>}
          </div>
          {nextUp && (
            <Link href={`/learn/${nextUp.id}`}
              className="flex basis-full items-center justify-center gap-1 rounded-full bg-gradient-to-b from-gold-hi to-gold px-4 py-1.5 text-sm font-semibold text-black sm:basis-auto">
              {done ? "Continue" : "Start"} <Icon name="arrow" className="h-4 w-4" />
            </Link>
          )}
        </div>
      )}
      {error && <p role="alert" className="text-sm text-down">{error}</p>}

      {!lessons ? !error && <div className="h-80 animate-pulse rounded-2xl bg-surface-2" /> : (
        <ol className="relative space-y-3 before:absolute before:bottom-6 before:left-[1.2rem] before:top-6 before:w-px before:bg-border">
          {lessons.map((l, i) => {
            const p = progress[l.id];
            return (
              <li key={l.id} className="relative">
                <Link href={`/learn/${l.id}`} className="card group flex gap-4 p-4 transition-colors hover:border-gold/40">
                  <span className={`relative z-10 grid h-10 w-10 shrink-0 place-items-center rounded-full text-sm font-semibold ring-1 ${
                    p ? "bg-gold text-black ring-gold" : "bg-surface text-muted ring-border group-hover:text-gold"}`}>
                    {p ? <Icon name="check" className="h-4 w-4" /> : i + 1}
                  </span>
                  <div className="min-w-0 flex-1">
                    <p className="text-xs text-muted">{l.year} · {l.minutes} min read, then a week to trade</p>
                    <h2 className="font-semibold group-hover:text-gold">{l.title}</h2>
                    <p className="mt-0.5 text-sm text-muted">{l.summary}</p>
                    {p && (
                      <p className="mt-1.5 text-xs text-muted">
                        Finished: <span className={p.return_pct >= 0 ? "text-up" : "text-down"}>{p.return_pct >= 0 ? "+" : ""}{p.return_pct.toFixed(2)}%</span> over {p.trades} trade{p.trades === 1 ? "" : "s"}
                      </p>
                    )}
                  </div>
                </Link>
              </li>
            );
          })}
        </ol>
      )}
      <p className="text-[11px] text-muted">These lessons describe what happened in the past. They don&apos;t say what gold will do next, and nothing here is advice.</p>
    </div>
  );
}
