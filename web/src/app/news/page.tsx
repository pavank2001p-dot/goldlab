"use client";

import { useEffect, useState } from "react";
import { Chips, Empty, Icon, PageHeader } from "@/components/ui";
import { api, type CalendarEvent, type NewsFeed, type NewsItem } from "@/lib/api";

const IMPACT = {
  bullish: { label: "Good for gold", cls: "bg-up/15 text-up", bar: "bg-up", icon: "up" },
  bearish: { label: "Bad for gold", cls: "bg-down/15 text-down", bar: "bg-down", icon: "down" },
  neutral: { label: "Neutral", cls: "bg-border text-muted", bar: "bg-muted/50", icon: "scale" },
} as const;

type Tone = "all" | "bullish" | "bearish" | "neutral";

function ago(iso: string) {
  const mins = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
  if (mins < 60) return `${Math.max(mins, 1)} min ago`;
  if (mins < 60 * 24) return `${Math.round(mins / 60)} h ago`;
  return new Date(iso).toLocaleDateString("en-GB", { day: "numeric", month: "short" });
}

function countdown(iso: string, now: number) {
  const mins = Math.round((new Date(iso).getTime() - now) / 60000);
  if (mins < 0) return "Released";
  if (mins < 60) return `in ${mins} min`;
  if (mins < 60 * 24) return `in ${Math.round(mins / 60)} h`;
  const d = Math.round(mins / 1440);
  return `in ${d} ${d === 1 ? "day" : "days"}`;
}

const dayKey = (iso: string) => new Date(iso).toLocaleDateString(undefined, { weekday: "long", day: "numeric", month: "short" });
const time = (iso: string) => new Date(iso).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });

/** Share of good, bad and neutral headlines. */
function Mood({ items }: { items: NewsItem[] }) {
  const tagged = items.filter((n) => n.impact);
  if (tagged.length === 0) return null;
  const pct = (k: keyof typeof IMPACT) => (tagged.filter((n) => n.impact === k).length / tagged.length) * 100;
  return (
    <div className="rounded-xl border border-border bg-surface p-4">
      <div className="flex items-baseline justify-between">
        <p className="text-sm font-medium">Headline mood</p>
        <p className="text-xs text-muted">{tagged.length} tagged headlines</p>
      </div>
      <div className="mt-3 flex h-2.5 overflow-hidden rounded-full bg-border">
        {(["bullish", "neutral", "bearish"] as const).map((k) => (
          <div key={k} className={`bar-grow h-full ${IMPACT[k].bar}`} style={{ width: `${pct(k)}%` }} />
        ))}
      </div>
      <div className="mt-2 flex justify-between text-xs tabular-nums">
        <span className="text-up">{pct("bullish").toFixed(0)}% good</span>
        <span className="text-muted">{pct("neutral").toFixed(0)}% neutral</span>
        <span className="text-down">{pct("bearish").toFixed(0)}% bad</span>
      </div>
    </div>
  );
}

export default function NewsPage() {
  const [feed, setFeed] = useState<NewsFeed | null>(null);
  const [events, setEvents] = useState<CalendarEvent[]>([]);
  const [goldOnly, setGoldOnly] = useState(false);
  const [tone, setTone] = useState<Tone>("all");
  const [open, setOpen] = useState<number | null>(null);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    api.news(goldOnly).then(setFeed, () => setFeed({ configured: false, tagging: false, items: [] }));
  }, [goldOnly]);
  useEffect(() => {
    api.calendar(21).then(setEvents, () => {});
    const id = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(id);
  }, []);

  const items = feed?.items ?? [];
  const shown = items.filter((n) => tone === "all" || n.impact === tone);
  const next = events.find((e) => new Date(e.ts).getTime() >= now);
  const days: [string, CalendarEvent[]][] = [];
  for (const e of events) {
    const k = dayKey(e.ts);
    const last = days[days.length - 1];
    if (last && last[0] === k) last[1].push(e);
    else days.push([k, [e]]);
  }

  return (
    <div className="mx-auto grid max-w-6xl gap-8 px-4 py-8 lg:grid-cols-[minmax(0,1fr)_340px]">
      <section className="min-w-0 space-y-5">
        <PageHeader icon="news" title="News that moves gold"
          subtitle="Each headline is tagged by AI as likely good, bad or neutral for gold, with a short reason. Tags are educational context, not trading advice, and can be wrong." />

        <Mood items={items} />

        <div className="flex flex-wrap items-center gap-3">
          <Chips<Tone> value={tone} onChange={setTone} options={[
            { key: "all", label: "All", count: items.length },
            { key: "bullish", label: "Good for gold", count: items.filter((n) => n.impact === "bullish").length, dot: "var(--up)" },
            { key: "bearish", label: "Bad for gold", count: items.filter((n) => n.impact === "bearish").length, dot: "var(--down)" },
            { key: "neutral", label: "Neutral", count: items.filter((n) => n.impact === "neutral").length, dot: "var(--muted)" },
          ]} />
          <label className="ml-auto flex cursor-pointer items-center gap-2 text-sm text-muted">
            <span className={`relative h-5 w-9 rounded-full transition-colors ${goldOnly ? "bg-gold" : "bg-border"}`}>
              <span className={`absolute top-0.5 h-4 w-4 rounded-full bg-foreground transition-all ${goldOnly ? "left-4.5" : "left-0.5"}`} />
            </span>
            <input type="checkbox" checked={goldOnly} onChange={(e) => setGoldOnly(e.target.checked)} className="sr-only" />
            Gold stories only
          </label>
        </div>

        <div className="space-y-3">
          {feed && items.length === 0 && (
            <Empty icon="news" title={feed.configured ? "No gold headlines yet" : "News feed not connected yet"}>
              {feed.configured ? "New headlines arrive every 30 minutes." : "Headlines will appear here once the news feed is switched on."}
            </Empty>
          )}
          {feed && items.length > 0 && shown.length === 0 && <Empty icon="search" title="No headlines match that filter" />}
          {shown.map((n, i) => {
            const imp = n.impact ? IMPACT[n.impact] : null;
            const expanded = open === n.id;
            return (
              <article key={n.id} className="rise-in group relative overflow-hidden rounded-xl border border-border bg-surface p-4 pl-5 transition hover:border-muted"
                style={{ animationDelay: `${Math.min(i, 10) * 30}ms` }}>
                <span className={`absolute inset-y-0 left-0 w-1 ${imp?.bar ?? "bg-border"}`} />
                <div className="flex flex-wrap items-center gap-2 text-xs text-muted">
                  {imp ? (
                    <span className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 font-medium ${imp.cls}`}>
                      <Icon name={imp.icon} className="h-3 w-3" strokeWidth={2.4} />{imp.label}
                    </span>
                  ) : (
                    <span className="rounded-full bg-border px-2 py-0.5">Not tagged yet</span>
                  )}
                  <span>{n.publisher}</span>
                  <span>·</span>
                  <span>{ago(n.published_at)}</span>
                </div>
                <h2 className="mt-2 font-medium leading-snug">
                  {n.url ? <a href={n.url} target="_blank" rel="noopener noreferrer" className="hover:text-gold">{n.headline}</a> : n.headline}
                </h2>
                {n.reason && <p className="mt-1.5 text-sm text-muted">{n.reason}</p>}
                {n.summary && (
                  <>
                    {expanded && <p className="mt-2 text-sm leading-relaxed">{n.summary}</p>}
                    <button onClick={() => setOpen(expanded ? null : n.id)} className="mt-2 text-xs text-gold hover:underline">
                      {expanded ? "Show less" : "Read summary"}
                    </button>
                  </>
                )}
              </article>
            );
          })}
        </div>
      </section>

      <aside className="space-y-4 lg:sticky lg:top-20 lg:self-start">
        <div className="flex items-center gap-2">
          <Icon name="calendar" className="h-4 w-4 text-gold" />
          <h2 className="font-medium">US events calendar</h2>
        </div>
        <p className="-mt-2 text-xs text-muted">High-impact US releases for the next three weeks, in your local time.</p>

        {next && (
          <div className="rounded-xl border border-gold/40 bg-gradient-to-br from-gold/15 to-transparent p-4">
            <p className="flex items-center gap-1.5 text-xs text-gold"><Icon name="clock" className="h-3.5 w-3.5" /> Next up · {countdown(next.ts, now)}</p>
            <p className="mt-1.5 font-medium">{next.title}</p>
            <p className="text-xs text-muted">{dayKey(next.ts)}, {time(next.ts)}</p>
            {next.why && <p className="mt-2 text-xs leading-relaxed text-muted">{next.why}</p>}
          </div>
        )}

        {events.length === 0 ? (
          <Empty icon="calendar" title="No upcoming events loaded" />
        ) : (
          <div className="max-h-[70vh] space-y-4 overflow-y-auto pr-1">
            {days.map(([d, evs]) => (
              <div key={d}>
                <p className="sticky top-0 bg-background py-1 text-xs font-medium uppercase tracking-wide text-muted">{d}</p>
                <ol className="mt-1 space-y-2 border-l border-border pl-3">
                  {evs.map((e) => {
                    const past = new Date(e.ts).getTime() < now;
                    return (
                      <li key={e.id} className={`relative rounded-lg border border-border p-3 ${past ? "opacity-50" : "bg-surface"}`}>
                        <span className={`absolute -left-[17px] top-4 h-2 w-2 rounded-full ring-4 ring-background ${e.impact === "High" ? "bg-down" : "bg-gold"}`} />
                        <div className="flex items-center justify-between text-xs text-muted">
                          <span className="tabular-nums">{time(e.ts)}</span>
                          <span className={past ? "" : "text-gold"}>{countdown(e.ts, now)}</span>
                        </div>
                        <p className="mt-1 text-sm font-medium">{e.title}</p>
                        {(e.forecast || e.previous) && (
                          <div className="mt-1.5 flex gap-2 text-[11px]">
                            {e.forecast && <span className="rounded bg-background px-1.5 py-0.5"><span className="text-muted">Forecast</span> {e.forecast}</span>}
                            {e.previous && <span className="rounded bg-background px-1.5 py-0.5"><span className="text-muted">Previous</span> {e.previous}</span>}
                          </div>
                        )}
                        {e.why && <p className="mt-1.5 text-xs text-muted">{e.why}</p>}
                      </li>
                    );
                  })}
                </ol>
              </div>
            ))}
          </div>
        )}
      </aside>
    </div>
  );
}
