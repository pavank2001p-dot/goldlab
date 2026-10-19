"use client";

import { useEffect, useState } from "react";
import { api, type CalendarEvent, type NewsFeed } from "@/lib/api";

const IMPACT = {
  bullish: { label: "Good for gold", cls: "bg-up/15 text-up" },
  bearish: { label: "Bad for gold", cls: "bg-down/15 text-down" },
  neutral: { label: "Neutral", cls: "bg-border text-muted" },
} as const;

function ago(iso: string) {
  const mins = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
  if (mins < 60) return `${Math.max(mins, 1)} min ago`;
  if (mins < 60 * 24) return `${Math.round(mins / 60)} h ago`;
  return new Date(iso).toLocaleDateString("en-GB", { day: "numeric", month: "short" });
}

function when(iso: string) {
  return new Date(iso).toLocaleString(undefined, { weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
}

export default function NewsPage() {
  const [feed, setFeed] = useState<NewsFeed | null>(null);
  const [events, setEvents] = useState<CalendarEvent[]>([]);
  const [goldOnly, setGoldOnly] = useState(false);

  useEffect(() => {
    api.news(goldOnly).then(setFeed, () => setFeed({ configured: false, tagging: false, items: [] }));
  }, [goldOnly]);
  useEffect(() => {
    api.calendar(21).then(setEvents, () => {});
  }, []);

  const now = Date.now();
  return (
    <div className="mx-auto grid max-w-6xl gap-8 px-4 py-8 lg:grid-cols-[1fr_340px]">
      <section className="min-w-0">
        <div className="flex flex-wrap items-center gap-3">
          <h1 className="text-xl font-semibold">News that moves gold</h1>
          <label className="ml-auto flex items-center gap-2 text-sm text-muted">
            <input type="checkbox" checked={goldOnly} onChange={(e) => setGoldOnly(e.target.checked)} className="accent-[var(--gold)]" />
            Only stories about gold itself
          </label>
        </div>
        <p className="mt-1 text-sm text-muted">
          Each headline is tagged by AI as likely good, bad or neutral for gold, with a short reason. Tags are
          educational context, not trading advice, and can be wrong.
        </p>

        <div className="mt-5 space-y-3">
          {feed && feed.items.length === 0 && (
            <p className="rounded-lg border border-dashed border-border p-6 text-center text-sm text-muted">
              {feed.configured ? "No gold-related headlines yet. New ones arrive every 30 minutes." : "The news feed isn't connected yet. Headlines will appear here once it is."}
            </p>
          )}
          {feed?.items.map((n) => (
            <article key={n.id} className="rounded-lg border border-border bg-surface p-4">
              <div className="flex flex-wrap items-center gap-2 text-xs text-muted">
                {n.impact ? (
                  <span className={`rounded px-1.5 py-0.5 font-medium ${IMPACT[n.impact].cls}`}>{IMPACT[n.impact].label}</span>
                ) : (
                  <span className="rounded bg-border px-1.5 py-0.5">Not tagged yet</span>
                )}
                <span>{n.publisher}</span>
                <span>·</span>
                <span>{ago(n.published_at)}</span>
              </div>
              <h2 className="mt-2 font-medium leading-snug">
                {n.url ? <a href={n.url} target="_blank" rel="noopener noreferrer" className="hover:text-gold">{n.headline}</a> : n.headline}
              </h2>
              {n.reason && <p className="mt-1.5 text-sm text-muted">{n.reason}</p>}
            </article>
          ))}
        </div>
      </section>

      <aside>
        <h2 className="font-medium">US events calendar</h2>
        <p className="mt-1 text-xs text-muted">High-impact US releases for the next three weeks, in your local time.</p>
        <ol className="mt-3 space-y-2">
          {events.length === 0 && <li className="text-sm text-muted">No upcoming events loaded.</li>}
          {events.map((e) => {
            const past = new Date(e.ts).getTime() < now;
            return (
              <li key={e.id} className={`rounded-lg border border-border p-3 ${past ? "opacity-50" : "bg-surface"}`}>
                <div className="flex items-center gap-2 text-xs text-muted">
                  <span className={`h-2 w-2 rounded-full ${e.impact === "High" ? "bg-down" : "bg-gold"}`} />
                  {when(e.ts)}
                </div>
                <p className="mt-1 text-sm font-medium">{e.title}</p>
                {(e.forecast || e.previous) && (
                  <p className="mt-0.5 text-xs text-muted">
                    {e.forecast && <>Forecast {e.forecast}</>}
                    {e.forecast && e.previous && " · "}
                    {e.previous && <>Previous {e.previous}</>}
                  </p>
                )}
                {e.why && <p className="mt-1 text-xs text-muted">{e.why}</p>}
              </li>
            );
          })}
        </ol>
      </aside>
    </div>
  );
}
