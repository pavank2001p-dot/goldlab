"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { api, type Lab, type LabStageKey } from "@/lib/api";
import { STAGE_ICON } from "@/lib/loop";
import { Icon } from "./ui";


const SHORT: Record<LabStageKey, string> = {
  spark: "Find an idea", build: "Make it rules", test: "Try it on the past", play: "Trade it on paper", review: "Learn from it",
};

/** How far along the track the gold line reaches: to the last done stop, and halfway on to the next. */
const reach = (done: number) => (done === 0 ? 0 : (done - 1) * 20 + (done < 5 ? 10 : 0));

/** The loop as a track of five stops. Done stops are filled, the current one glows. */
function Track({ lab }: { lab: Lab }) {
  return (
    <ol className="relative grid grid-cols-5 gap-1" aria-label="This lap of the loop">
      <span aria-hidden className="absolute left-[10%] right-[10%] top-5 h-px bg-border" />
      <span aria-hidden className="absolute left-[10%] top-5 h-px bg-gold transition-[width] duration-700"
        style={{ width: `${reach(lab.stages.filter((s) => s.state === "done").length)}%` }} />
      {lab.stages.map((s, i) => (
        <li key={s.key} className="relative flex flex-col items-center text-center">
          <Link href={s.href} title={`${s.name}: ${s.title}`}
            aria-current={s.state === "current" ? "step" : undefined}
            className={`relative z-10 flex h-10 w-10 items-center justify-center rounded-full border transition-colors ${
              s.state === "done" ? "border-gold bg-gold text-black"
                : s.state === "current" ? "border-gold bg-surface text-gold shadow-[0_0_0_4px_color-mix(in_srgb,var(--gold)_18%,transparent)]"
                : "border-border bg-surface text-muted hover:border-gold/50 hover:text-foreground"}`}>
            <Icon name={s.state === "done" ? "check" : STAGE_ICON[s.key]} className="h-4 w-4" />
            {s.state === "current" && <span aria-hidden className="breathe absolute inset-0 rounded-full border border-gold/60" />}
          </Link>
          <span className={`mt-2 text-xs font-medium sm:text-sm ${s.state === "todo" ? "text-muted" : ""}`}>
            <span className="hidden text-muted sm:inline">{i + 1}. </span>{s.name}
          </span>
          <span className="mt-0.5 hidden text-[11px] leading-snug text-muted md:block">{SHORT[s.key]}</span>
        </li>
      ))}
    </ol>
  );
}

function Level({ lab }: { lab: Lab }) {
  const { level, xp } = lab;
  const span = level.next ? level.next.at - level.floor : 1;
  const pct = level.next ? Math.min(100, ((xp - level.floor) / span) * 100) : 100;
  return (
    <section className="card rise-in flex flex-col p-5" aria-label="Your lab level">
      <div className="flex items-center gap-3">
        <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl border border-gold/30 bg-gradient-to-br from-gold/25 to-gold/5 font-mono text-lg font-bold text-gold">
          {level.rank}
        </span>
        <div className="min-w-0">
          <p className="text-xs uppercase tracking-wider text-muted">Level {level.rank}</p>
          <p className="truncate text-lg font-semibold">{level.name}</p>
        </div>
        <p className="ml-auto text-right text-sm tabular-nums"><span className="font-semibold text-gold">{xp.toLocaleString("en-US")}</span> XP</p>
      </div>
      <div className="mt-4 h-2 overflow-hidden rounded-full bg-surface-2" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(pct)}>
        <div className="h-full rounded-full bg-gradient-to-r from-gold to-gold-hi transition-[width] duration-700" style={{ width: `${pct}%` }} />
      </div>
      <p className="mt-2 text-xs text-muted">
        {level.next ? <>{(level.next.at - xp).toLocaleString("en-US")} XP to {level.next.name}. </> : "Top level reached. "}
        {lab.laps > 0 ? `${lab.laps} lap${lab.laps > 1 ? "s" : ""} of the loop done.` : "Finish a lap for 100 XP."}
      </p>
      <details className="group mt-3 text-sm">
        <summary className="flex cursor-pointer list-none items-center gap-1 text-xs text-muted transition-colors hover:text-gold">
          How XP works <Icon name="down" className="h-3 w-3 transition-transform group-open:rotate-180" />
        </summary>
        <p className="mt-2 text-xs text-muted">XP comes from process, never from profit. Each habit counts up to a limit.</p>
        <ul className="mt-2 space-y-1 text-xs">
          {lab.sources.map((s) => (
            <li key={s.key} className="flex justify-between gap-2">
              <span className="text-muted">{s.label} <span className="tabular-nums">({s.count})</span></span>
              <span className="tabular-nums">{s.xp}</span>
            </li>
          ))}
        </ul>
      </details>
    </section>
  );
}

/** The top of the signed-in home: today's mission, the loop, your level and where you left off. */
export default function LabHome() {
  const [lab, setLab] = useState<Lab | null>(null);
  useEffect(() => {
    const load = () => api.lab().then(setLab, () => {});
    load();
    const onShow = () => document.visibilityState === "visible" && load();
    document.addEventListener("visibilitychange", onShow);
    return () => document.removeEventListener("visibilitychange", onShow);
  }, []);

  if (!lab) return <div className="relative mt-8 h-64 animate-pulse rounded-3xl bg-surface-2" />;
  const m = lab.mission;
  const stageName = m.stage === "limits" ? "Before you start" : lab.stages.find((s) => s.key === m.stage)?.name;

  return (
    <div className="relative mt-8 grid gap-4 lg:grid-cols-3" data-tour="lab">
      <section className="card rise-in relative overflow-hidden p-5 sm:p-6 lg:col-span-2">
        <div aria-hidden className="pointer-events-none absolute -right-16 -top-16 h-48 w-48 rounded-full bg-gold/10 blur-3xl" />
        <div className="relative flex flex-wrap items-center gap-2 text-xs">
          <span className="rounded-full border border-gold/30 bg-gold/10 px-2.5 py-1 font-medium text-gold">Today&apos;s mission</span>
          <span className="text-muted">{stageName}{lab.laps ? ` · lap ${lab.laps + 1}` : ""}</span>
          <span className="ml-auto rounded-full bg-surface-2 px-2.5 py-1 tabular-nums text-muted">+{m.xp} XP</span>
        </div>
        <div className="relative mt-4 flex items-start gap-4">
          <span className="hidden h-12 w-12 shrink-0 items-center justify-center rounded-2xl border border-gold/25 bg-gradient-to-br from-gold/20 to-gold/5 text-gold sm:flex">
            <Icon name={STAGE_ICON[m.stage]} className="h-6 w-6" />
          </span>
          <div className="min-w-0 flex-1">
            <h2 className="text-xl font-bold tracking-tight sm:text-2xl">{m.title}</h2>
            <p className="mt-1 text-sm leading-relaxed text-muted">{m.detail}</p>
          </div>
        </div>
        <Link href={m.href}
          className="group relative mt-5 inline-flex items-center gap-2 rounded-full bg-gradient-to-b from-gold-hi to-gold px-5 py-2.5 text-sm font-semibold text-black shadow-[0_10px_30px_-14px_var(--gold)] transition-[filter] hover:brightness-105">
          {m.cta} <Icon name="arrow" className="h-4 w-4 transition-transform group-hover:translate-x-0.5" />
        </Link>
        <div className="relative mt-7 border-t border-border pt-5">
          <p className="mb-4 text-xs text-muted">
            Every lap goes Spark, Build, Test, Play, Review. Tap any stop to jump there.
          </p>
          <Track lab={lab} />
        </div>
      </section>

      <div className="flex flex-col gap-4">
        <Level lab={lab} />
        {lab.resume.length > 0 && (
          <section className="card rise-in p-5" aria-label="Where you left off">
            <p className="text-sm text-muted">Where you left off</p>
            <ul className="mt-3 space-y-1">
              {lab.resume.map((r) => (
                <li key={r.href + r.title}>
                  <Link href={r.href} className="-mx-2 flex items-center gap-3 rounded-xl px-2 py-2 transition-colors hover:bg-surface-2">
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm font-medium">{r.title}</span>
                      <span className="block text-xs text-muted">{r.detail}</span>
                    </span>
                    <Icon name="arrow" className="h-3.5 w-3.5 shrink-0 text-muted" />
                  </Link>
                </li>
              ))}
            </ul>
          </section>
        )}
      </div>
    </div>
  );
}
