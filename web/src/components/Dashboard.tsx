"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { api, fmtUsd, type Achievements, type AgentState, type CalendarEvent, type PaperState, type User } from "@/lib/api";
import { useBadgeToasts, Streak } from "./Badges";
import LabHome from "./LabHome";
import { MirrorJar } from "./MoneyMirror";
import PriceTicker from "./PriceTicker";
import { CountUp, Icon } from "./ui";

const POLL_MS = 15_000;

/** The last two days of hourly closes as a soft area line. */
function Spark({ closes }: { closes: number[] }) {
  if (closes.length < 2) return <div className="h-28 animate-pulse rounded-xl bg-surface-2" />;
  const w = 600, h = 112, lo = Math.min(...closes), span = Math.max(...closes) - lo || 1;
  const pts = closes.map((c, i) => `${((i / (closes.length - 1)) * w).toFixed(1)},${(h - 6 - ((c - lo) / span) * (h - 12)).toFixed(1)}`);
  const up = closes[closes.length - 1] >= closes[0];
  const color = up ? "var(--up)" : "var(--down)";
  return (
    <svg viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none" className="fan-in h-28 w-full" aria-label={`Gold over the last ${closes.length} hours`}>
      <defs>
        <linearGradient id="spark-fill" x1="0" x2="0" y1="0" y2="1">
          <stop offset="0" stopColor={color} stopOpacity="0.28" />
          <stop offset="1" stopColor={color} stopOpacity="0" />
        </linearGradient>
      </defs>
      <polygon points={`0,${h} ${pts.join(" ")} ${w},${h}`} fill="url(#spark-fill)" />
      <polyline points={pts.join(" ")} fill="none" stroke={color} strokeWidth="2" vectorEffect="non-scaling-stroke" strokeLinejoin="round" />
    </svg>
  );
}

function greeting(d: Date) {
  const h = d.getHours();
  return h < 5 ? "Good evening" : h < 12 ? "Good morning" : h < 18 ? "Good afternoon" : "Good evening";
}

function Tile({ title, icon, href, cta, children, className = "", tour }: {
  title: string; icon: string; href?: string; cta?: string; children: React.ReactNode; className?: string; tour?: string;
}) {
  return (
    <section data-tour={tour} className={`card rise-in flex flex-col p-5 ${className}`}>
      <div className="flex items-center gap-2 text-sm text-muted">
        <span className="flex h-7 w-7 items-center justify-center rounded-lg bg-gold/10 text-gold"><Icon name={icon} className="h-4 w-4" /></span>
        {title}
        {href && (
          <Link href={href} className="ml-auto flex items-center gap-1 text-xs transition-colors hover:text-gold">
            {cta ?? "Open"} <Icon name="arrow" className="h-3 w-3" />
          </Link>
        )}
      </div>
      <div className="mt-4 flex-1">{children}</div>
    </section>
  );
}

function when(ts: string, now: Date) {
  const d = new Date(ts);
  const sameDay = d.toDateString() === now.toDateString();
  const tomorrow = new Date(now.getTime() + 86_400_000).toDateString() === d.toDateString();
  const time = d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
  return sameDay ? `Today ${time}` : tomorrow ? `Tomorrow ${time}` : d.toLocaleDateString("en-US", { weekday: "short", day: "numeric", month: "short" });
}

/** The signed-in home: price, practice account, agent, today's events and habits at a glance. */
export default function Dashboard({ user }: { user: User }) {
  const [paper, setPaper] = useState<PaperState | null>(null);
  const [agent, setAgent] = useState<AgentState | null>(null);
  const [events, setEvents] = useState<CalendarEvent[] | null>(null);
  const [habits, setHabits] = useState<Achievements | null>(null);
  const [now, setNow] = useState(() => new Date());
  const [closes, setCloses] = useState<number[]>([]);
  useBadgeToasts(habits);

  useEffect(() => {
    const load = () => {
      api.paper().then(setPaper, () => {});
      api.agent().then(setAgent, () => {});
      api.candles("1h", { limit: 48 }).then((b) => setCloses(b.map((x) => x.c)), () => {});
      setNow(new Date());
    };
    load();
    api.calendar(7).then(setEvents, () => setEvents([]));
    api.achievements().then(setHabits, () => {});
    const t = setInterval(() => document.visibilityState === "visible" && load(), POLL_MS);
    return () => clearInterval(t);
  }, []);

  const a = paper?.account;
  const upcoming = (events ?? []).filter((e) => new Date(e.ts).getTime() > now.getTime() - 3_600_000).slice(0, 4);
  const ag = agent?.agent;
  const nextBadge = habits?.badges.filter((b) => !b.earned).sort((x, y) => y.progress / y.goal - x.progress / x.goal)[0];

  return (
    <section className="relative pb-4 pt-10 sm:pt-14">
      <div aria-hidden className="pointer-events-none absolute -top-24 left-1/2 h-72 w-[44rem] max-w-full -translate-x-1/2 rounded-full bg-gold/10 blur-3xl" />
      <div className="relative flex flex-wrap items-end justify-between gap-4">
        <div>
          <p className="text-sm text-muted">{now.toLocaleDateString("en-US", { weekday: "long", day: "numeric", month: "long" })}</p>
          <h1 className="mt-1 text-3xl font-bold tracking-tight sm:text-4xl">
            {greeting(now)}{user.name ? <>, <span className="bg-gradient-to-r from-gold via-gold-hi to-gold bg-clip-text text-transparent">{user.name}</span></> : null}.
          </h1>
          <p className="mt-1 text-muted">Here is your lab. One lap at a time, and take a breath before you decide anything.</p>
        </div>
        <div className="flex gap-2">
          <Link href="/paper" className="rounded-full bg-gradient-to-b from-gold-hi to-gold px-5 py-2 text-sm font-semibold text-black shadow-[0_10px_30px_-14px_var(--gold)] transition-[filter] hover:brightness-105">
            Practise a trade
          </Link>
          <Link href="/strategies/builder" className="rounded-full border border-border bg-surface/60 px-5 py-2 text-sm font-medium backdrop-blur transition-colors hover:border-gold/40">
            Strategy studio
          </Link>
        </div>
      </div>

      <LabHome />

      <div className="relative mt-4 grid gap-4 md:grid-cols-2 lg:grid-cols-3">
        <Tile title="Gold right now" icon="candles" href="/chart" cta="Chart" className="lg:col-span-2" tour="price">
          <PriceTicker />
          <div className="mt-3"><Spark closes={closes} /></div>
          <p className="text-[11px] text-muted">Last 48 hours, hourly closes.</p>
        </Tile>

        <Tile title="Paper account" icon="wallet" href="/paper" tour="paper">
          {a ? (
            <>
              <p className="text-3xl font-bold tabular-nums tracking-tight"><CountUp value={a.equity} format={(v) => fmtUsd(v)} /></p>
              <p className={`mt-1 text-sm tabular-nums ${a.return_pct >= 0 ? "text-up" : "text-down"}`}>
                {a.return_pct >= 0 ? "+" : ""}{a.return_pct.toFixed(2)}% since you started
              </p>
              <div className="mt-4 grid grid-cols-2 gap-2 text-xs">
                <div className="rounded-xl bg-background/50 p-2.5">
                  <p className="text-muted">Open P&amp;L</p>
                  <p className={`mt-0.5 text-sm font-semibold tabular-nums ${a.unrealized >= 0 ? "text-up" : "text-down"}`}>
                    {a.unrealized >= 0 ? "+" : ""}{fmtUsd(a.unrealized)}
                  </p>
                </div>
                <div className="rounded-xl bg-background/50 p-2.5">
                  <p className="text-muted">Open trades</p>
                  <p className="mt-0.5 text-sm font-semibold tabular-nums">{paper!.positions.length}</p>
                </div>
              </div>
            </>
          ) : <div className="h-24 animate-pulse rounded-xl bg-surface-2" />}
        </Tile>

        <Tile title="Strategy agent" icon="bolt" href="/paper/agent" tour="agent">
          {agent == null ? <div className="h-16 animate-pulse rounded-xl bg-surface-2" /> : ag ? (
            <>
              <p className="flex items-center gap-2 font-semibold">
                <span className={`h-2 w-2 rounded-full ${ag.status === "running" ? "breathe bg-up" : "bg-muted"}`} />
                {ag.status === "running" ? "Running" : "Stopped"}: {ag.label}
              </p>
              <p className="mt-1 text-sm text-muted">
                {ag.status === "running"
                  ? ag.signal > 0 ? "Its rules currently say long." : ag.signal < 0 ? "Its rules currently say short." : "Its rules say stay out for now."
                  : "Start it again whenever you like."}
              </p>
              {agent.live && (
                <p className={`mt-3 text-sm tabular-nums ${agent.live.stats.net_profit >= 0 ? "text-up" : "text-down"}`}>
                  {agent.live.stats.net_profit >= 0 ? "+" : ""}{fmtUsd(agent.live.stats.net_profit)} over {agent.live.stats.trades} trade{agent.live.stats.trades === 1 ? "" : "s"}
                </p>
              )}
            </>
          ) : (
            <>
              <p className="font-semibold">No agent running</p>
              <p className="mt-1 text-sm text-muted">Let a strategy trade your paper account and explain each decision.</p>
            </>
          )}
        </Tile>

        <Tile title="Key events" icon="calendar" href="/news" cta="Calendar" tour="events">
          {events == null ? <div className="h-16 animate-pulse rounded-xl bg-surface-2" /> : upcoming.length ? (
            <ul className="space-y-2.5">
              {upcoming.map((e) => (
                <li key={e.id} className="flex items-start gap-3 text-sm">
                  <span className={`mt-1.5 h-2 w-2 shrink-0 rounded-full ${e.impact === "High" ? "bg-down" : "bg-gold"}`} />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate font-medium">{e.title}</span>
                    <span className="block text-xs text-muted">{when(e.ts, now)} · {e.country}</span>
                  </span>
                </li>
              ))}
            </ul>
          ) : <p className="text-sm text-muted">No major releases in the next week. A quieter calendar often means calmer prices.</p>}
        </Tile>

        <Tile title="Money Mirror" icon="wallet" tour="mirror" className="lg:col-span-2">
          <MirrorJar returnPct={a ? a.return_pct : null} />
        </Tile>

        <Tile title="Your habits" icon="trophy" href="/account#habits" cta="All badges" tour="habits">
          {habits ? (
            <>
              <Streak s={habits.streak} compact />
              <p className="mt-3 text-sm">
                <span className="font-semibold text-gold">{habits.earned}</span> of {habits.badges.length} badges earned.
                {nextBadge && <span className="text-muted"> Next: {nextBadge.title} ({nextBadge.progress} of {nextBadge.goal}).</span>}
              </p>
            </>
          ) : <div className="h-24 animate-pulse rounded-xl bg-surface-2" />}
        </Tile>
      </div>
    </section>
  );
}
