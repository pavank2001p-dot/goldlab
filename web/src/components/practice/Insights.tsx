"use client";

import { useEffect, useState } from "react";
import { api, type Insights as Data } from "@/lib/api";
import { Icon } from "../ui";

const TONE = {
  warn: { ring: "border-down/30", chip: "bg-down/15 text-down", icon: "drop", label: "Worth a look" },
  info: { ring: "border-border", chip: "bg-gold/15 text-gold", icon: "chart", label: "Pattern" },
  good: { ring: "border-up/30", chip: "bg-up/15 text-up", icon: "check", label: "Good habit" },
} as const;

/** Habits spotted in closed trades: quick trades after losses, bigger sizes after losses, busy days, stops and more. */
export default function Insights({ source, refresh = 0 }: { source: "paper" | "journal"; refresh?: number }) {
  const [d, setD] = useState<Data | null>(null);
  useEffect(() => { api.insights(source).then(setD, () => {}); }, [source, refresh]);
  if (!d) return <div className="h-32 animate-pulse rounded-2xl bg-surface" />;
  if (d.trades < d.needed) {
    return (
      <div className="card p-5 text-sm">
        <p className="font-medium">Habit insights unlock after {d.needed} closed trades</p>
        <p className="mt-1 text-muted">You have {d.trades}. Then this shows patterns such as trading again right after a loss, raising size to win it back, or very busy days.</p>
        <div className="mt-3 h-1.5 overflow-hidden rounded-full bg-border"><div className="h-full bg-gold" style={{ width: `${(d.trades / d.needed) * 100}%` }} /></div>
      </div>
    );
  }
  return (
    <div className="space-y-3">
      <p className="text-sm text-muted">From your {d.trades} closed {source === "paper" ? "practice" : "logged"} trades. These describe habits, not whether any trade was right.</p>
      <div className="grid gap-3 md:grid-cols-2">
        {d.items.map((i, k) => {
          const t = TONE[i.tone];
          return (
            <article key={i.key} className={`rise-in rounded-2xl border bg-surface p-4 ${t.ring}`} style={{ animationDelay: `${k * 40}ms` }}>
              <div className="flex items-center gap-2">
                <span className={`flex h-7 w-7 items-center justify-center rounded-lg ${t.chip}`}><Icon name={t.icon} className="h-4 w-4" /></span>
                <div className="min-w-0 flex-1">
                  <p className="text-[11px] uppercase tracking-wide text-muted">{t.label}</p>
                  <h3 className="truncate font-medium">{i.title}</h3>
                </div>
                <span className="text-lg font-semibold tabular-nums">{i.metric}</span>
              </div>
              <p className="mt-2 text-sm leading-relaxed text-muted">{i.body}</p>
            </article>
          );
        })}
      </div>
    </div>
  );
}
