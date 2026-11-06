"use client";

import Link from "next/link";
import { useEffect, useRef } from "react";
import type { Achievements, Badge } from "@/lib/api";
import { toast } from "./Toaster";
import { Icon } from "./ui";

const SEEN = "goldlab-badges-seen";

/** Toast badges earned since this browser last looked, once each. */
export function useBadgeToasts(data: Achievements | null) {
  const done = useRef(false);
  useEffect(() => {
    if (!data || done.current) return;
    done.current = true;
    let seen: string[] | null = null;
    try { seen = JSON.parse(localStorage.getItem(SEEN) ?? "null"); } catch {}
    const earned = data.badges.filter((b) => b.earned).map((b) => b.key);
    // The first visit only records what's already earned, so old badges don't all pop at once.
    if (seen) for (const b of data.badges) if (b.earned && !seen.includes(b.key)) toast(`Badge earned: ${b.title}`, { tone: "badge", body: b.blurb });
    try { localStorage.setItem(SEEN, JSON.stringify(earned)); } catch {}
  }, [data]);
}

function Medal({ b, i }: { b: Badge; i: number }) {
  const pct = Math.round((b.progress / b.goal) * 100);
  const r = 22, c = 2 * Math.PI * r;
  return (
    <li className="rise-in group relative flex gap-3 rounded-2xl border border-border bg-background/40 p-3 transition-colors hover:border-gold/40"
      style={{ animationDelay: `${i * 50}ms` }}>
      <span className="relative h-14 w-14 shrink-0">
        <svg viewBox="0 0 52 52" className="h-14 w-14 -rotate-90" aria-hidden>
          <circle cx="26" cy="26" r={r} fill="none" stroke="var(--border)" strokeWidth="3" />
          <circle cx="26" cy="26" r={r} fill="none" stroke="var(--gold)" strokeWidth="3" strokeLinecap="round"
            className="ring-draw" strokeDasharray={`${(c * pct) / 100} ${c}`} />
        </svg>
        <span className={`absolute inset-[7px] flex items-center justify-center rounded-full ${b.earned
          ? "bg-gradient-to-br from-gold-hi to-gold-deep text-black shadow-[0_0_24px_-4px_var(--gold)]"
          : "bg-surface-2 text-muted"}`}>
          <Icon name={b.icon} className="h-5 w-5" />
        </span>
        {b.earned && <span aria-hidden className="shimmer absolute inset-[7px] rounded-full" />}
      </span>
      <div className="min-w-0">
        <p className={`text-sm font-semibold ${b.earned ? "" : "text-foreground/85"}`}>{b.title}</p>
        <p className="mt-0.5 text-xs leading-snug text-muted">{b.blurb}</p>
        <p className={`mt-1 text-[11px] font-medium tabular-nums ${b.earned ? "text-gold" : "text-muted"}`}>
          {b.earned ? "Earned" : b.goal > 1 ? `${b.progress} of ${b.goal}` : "Not yet"}
        </p>
      </div>
    </li>
  );
}

/** Seven small flames for the last week: lit if the streak covers that day. */
export function Streak({ s, compact = false }: { s: Achievements["streak"]; compact?: boolean }) {
  const lit = Math.min(s.current, 7);
  const offset = s.logged_today ? 0 : 1; // an unlogged today is still open, not a miss
  return (
    <div className={compact ? "" : "rounded-2xl border border-border bg-background/40 p-4"}>
      <div className="flex items-baseline gap-2">
        <span className="text-3xl font-bold tabular-nums">{s.current}</span>
        <span className="text-sm text-muted">day{s.current === 1 ? "" : "s"} journal streak</span>
      </div>
      <div className="mt-3 flex gap-1.5" aria-hidden>
        {Array.from({ length: 7 }, (_, i) => {
          const daysAgo = 6 - i;
          const on = daysAgo >= offset && daysAgo < lit + offset;
          const today = daysAgo === 0;
          return (
            <span key={i} className={`flex h-8 flex-1 items-center justify-center rounded-lg border text-xs transition-colors ${on
              ? "border-gold/50 bg-gradient-to-t from-gold/30 to-gold/5 text-gold"
              : today ? "border-dashed border-gold/40 text-muted" : "border-border text-border"}`}>
              <svg viewBox="0 0 24 24" className="h-4 w-4" fill="currentColor"><path d="M12 2c1 3.5 5 5.5 5 10.5A5 5 0 0 1 7 12.5c0-2 1-3.5 2-4.5 0 2 1 3 2 3 0-3-1-5 1-9Z" /></svg>
            </span>
          );
        })}
      </div>
      <p className="mt-2 text-xs text-muted">
        {s.logged_today ? "Logged today. " : <><Link href="/trades" className="text-gold hover:underline">Log a trade</Link> today to keep it going. </>}
        Best: {s.best} day{s.best === 1 ? "" : "s"}.
      </p>
    </div>
  );
}

export default function Badges({ data }: { data: Achievements }) {
  useBadgeToasts(data);
  return (
    <div className="grid gap-4 lg:grid-cols-[16rem_1fr]">
      <div className="space-y-4">
        <div className="rounded-2xl border border-gold/30 bg-gradient-to-br from-gold/15 to-transparent p-4">
          <p className="text-xs font-medium uppercase tracking-wider text-gold">Habits</p>
          <p className="mt-1 text-3xl font-bold tabular-nums">{data.earned}<span className="text-lg text-muted"> / {data.badges.length}</span></p>
          <p className="mt-1 text-xs text-muted">Badges reward how you trade, never whether a trade made money.</p>
        </div>
        <Streak s={data.streak} />
      </div>
      <ul className="grid gap-3 sm:grid-cols-2">
        {data.badges.map((b, i) => <Medal key={b.key} b={b} i={i} />)}
      </ul>
    </div>
  );
}
