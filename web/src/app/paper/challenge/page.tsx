"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import ReplayPlayer from "@/components/practice/ReplayPlayer";
import ReplaySummary from "@/components/practice/ReplaySummary";
import SignInPrompt from "@/components/SignInPrompt";
import { Icon, PageHeader } from "@/components/ui";
import { api, type Board, type Challenge, type ReplaySettled, type ReplayTradeIn } from "@/lib/api";
import { TF_LABEL } from "@/lib/replay";
import { useUser } from "@/lib/useUser";

function Leaderboard({ board, title }: { board: Board; title: string }) {
  return (
    <section className="card p-5">
      <div className="flex items-baseline justify-between gap-2">
        <h2 className="font-semibold">{title}</h2>
        <span className="text-xs text-muted">{board.players} player{board.players === 1 ? "" : "s"}</span>
      </div>
      {board.top.length ? (
        <ol className="mt-3 space-y-1.5">
          {board.top.map((r) => (
            <li key={r.rank} className={`flex items-center gap-3 rounded-xl px-3 py-2 text-sm ${r.me ? "bg-gold/10 ring-1 ring-gold/40" : "bg-background/50"}`}>
              <span className={`w-6 text-center font-semibold tabular-nums ${r.rank <= 3 ? "text-gold" : "text-muted"}`}>{r.rank}</span>
              <span className="min-w-0 flex-1 truncate font-medium">{r.nickname}{r.me ? " (you)" : ""}</span>
              <span className="hidden text-xs text-muted tabular-nums sm:inline">dip {r.max_drawdown_pct.toFixed(1)}% · {r.trades} trade{r.trades === 1 ? "" : "s"}</span>
              <span className={`w-16 text-right font-semibold tabular-nums ${r.return_pct >= 0 ? "text-up" : "text-down"}`}>
                {r.return_pct >= 0 ? "+" : ""}{r.return_pct.toFixed(2)}%
              </span>
            </li>
          ))}
        </ol>
      ) : <p className="mt-3 text-sm text-muted">Nobody has joined the public board yet.</p>}
      <p className="mt-3 text-[11px] text-muted">Ranked by result, then by the smallest dip. Only players who chose to be listed appear, under a nickname.</p>
    </section>
  );
}

function OptIn({ board, nickname, onChange }: { board: Board; nickname: string | null; onChange: (b: Board) => void }) {
  const [nick, setNick] = useState(nickname ?? "");
  const [error, setError] = useState<string | null>(null);
  const pub = board.mine?.public ?? false;
  async function set(p: boolean) {
    setError(null);
    try { onChange(await api.challengeVisibility(p, nick.trim() || null)); }
    catch (e) { setError(e instanceof Error ? e.message : "Couldn't save that"); }
  }
  return (
    <div className="mt-4 rounded-xl border border-border p-3 text-sm">
      {board.mine && <p>You placed <span className="font-semibold text-gold">#{board.mine.rank}</span> of {board.players} this week.</p>}
      <p className="mt-1 text-muted">{pub ? `You're on the public leaderboard as ${board.mine?.nickname}.` : "Your result is private. Join the leaderboard under a nickname if you'd like to compare."}</p>
      <div className="mt-2 flex flex-wrap items-center gap-2">
        {!pub && <input value={nick} onChange={(e) => setNick(e.target.value)} placeholder="Nickname" maxLength={20} aria-label="Nickname"
          className="w-40 rounded-lg border border-border bg-background px-2.5 py-1.5 text-sm outline-none focus:border-gold" />}
        <button type="button" onClick={() => set(!pub)}
          className={pub ? "rounded-full border border-border px-3 py-1.5 text-xs hover:border-down/50" : "rounded-full bg-gradient-to-b from-gold-hi to-gold px-4 py-1.5 text-xs font-semibold text-black"}>
          {pub ? "Leave the leaderboard" : "Join the leaderboard"}
        </button>
      </div>
      {error && <p role="alert" className="mt-2 text-xs text-down">{error}</p>}
    </div>
  );
}

export default function ChallengePage() {
  const { user } = useUser();
  const [ch, setCh] = useState<Challenge | null>(null);
  const [playing, setPlaying] = useState(false);
  const [done, setDone] = useState<ReplaySettled[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (user) api.challenge().then(setCh, (e) => setError(e instanceof Error ? e.message : "Couldn't load the challenge"));
  }, [user]);

  const submit = useCallback(async (trades: ReplayTradeIn[], d: ReplaySettled[]) => {
    setDone(d);
    try {
      const r = await api.enterChallenge({ trades, public: false, nickname: null });
      setCh((c) => (c ? { ...c, board: r.board } : c));
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't record your result");
    }
  }, []);

  if (user === null) return <SignInPrompt what="play the weekly replay challenge" next="/paper/challenge" />;
  if (user === undefined) return null;

  const ends = ch ? new Date(`${ch.ends}T00:00:00Z`).toLocaleDateString("en-GB", { timeZone: "UTC", weekday: "long", day: "numeric", month: "long" }) : "";
  const played = !!ch?.board.mine;

  return (
    <div className="mx-auto max-w-6xl space-y-5 px-4 py-8">
      <PageHeader icon="trophy" title="Weekly replay challenge"
        subtitle="Everyone trades the same stretch of past gold prices this week. One go each, with a stop on every trade."
        right={<Link href="/paper/replay" className="basis-full rounded-full text-center sm:basis-auto border border-border px-4 py-1.5 text-sm hover:border-gold/40">Practise on any day</Link>} />
      {error && <p role="alert" className="text-sm text-down">{error}</p>}
      {!ch ? !error && <div className="h-64 animate-pulse rounded-2xl bg-surface-2" /> : playing ? (
        <div className="space-y-4">
          <ReplayPlayer bars={ch.bars} context={ch.context} balance={ch.rules.balance} leverage={ch.rules.leverage} riskPct={ch.rules.risk_pct} onFinish={submit} />
          {done && (
            <ReplaySummary done={done} balance={ch.rules.balance}>
              <p className="mt-3 text-sm text-muted">
                The mystery {ch.tf === "1h" ? "week started on" : "day was"}{" "}
                <span className="font-medium text-foreground">{new Date(ch.start * 1000).toLocaleDateString("en-GB", { timeZone: "UTC", weekday: "long", day: "numeric", month: "long", year: "numeric" })}</span>.
              </p>
              {ch.board.mine ? <OptIn board={ch.board} nickname={ch.nickname} onChange={(b) => setCh({ ...ch, board: b })} />
                : !error && <p className="mt-4 text-sm text-muted">Recording your result…</p>}
            </ReplaySummary>
          )}
          {done && <Leaderboard board={ch.board} title={`Leaderboard, ${ch.week}`} />}
        </div>
      ) : (
        <div className="grid gap-4 lg:grid-cols-[1fr_22rem]">
          <section className="card relative overflow-hidden p-6">
            <div aria-hidden className="pointer-events-none absolute -right-16 -top-16 h-48 w-48 rounded-full bg-gold/15 blur-3xl" />
            <p className="text-xs uppercase tracking-wider text-gold">{ch.week} · ends {ends}</p>
            {played ? (
              <>
                <h2 className="mt-2 text-2xl font-bold">You&apos;ve played this week</h2>
                <p className={`mt-1 text-3xl font-bold tabular-nums ${ch.board.mine!.return_pct >= 0 ? "text-up" : "text-down"}`}>
                  {ch.board.mine!.return_pct >= 0 ? "+" : ""}{ch.board.mine!.return_pct.toFixed(2)}%
                </p>
                <p className="text-sm text-muted">Deepest dip {ch.board.mine!.max_drawdown_pct.toFixed(2)}% over {ch.board.mine!.trades} trades. A new stretch arrives on Monday.</p>
                <OptIn board={ch.board} nickname={ch.nickname} onChange={(b) => setCh({ ...ch, board: b })} />
              </>
            ) : (
              <>
                <h2 className="mt-2 text-2xl font-bold">A mystery {ch.tf === "1h" ? "week" : "day"} of gold</h2>
                <p className="mt-1 text-sm text-muted">{ch.bars.length} {TF_LABEL[ch.tf]} candles, revealed one at a time. The date stays hidden until the end.</p>
                <ul className="mt-4 space-y-2 text-sm">
                  {[
                    `Start with $${ch.rules.balance.toLocaleString("en-US")} and up to 1:${ch.rules.leverage} leverage.`,
                    `Every trade needs a stop, and no trade may risk more than ${ch.rules.risk_pct}% of your balance.`,
                    "One trade at a time. Fills are at the candle close, with no spread.",
                    "You get one result per week. Pausing is fine; the result is saved when you finish.",
                  ].map((r) => (
                    <li key={r} className="flex gap-2"><Icon name="check" className="mt-0.5 h-4 w-4 shrink-0 text-gold" />{r}</li>
                  ))}
                </ul>
                <button type="button" onClick={() => setPlaying(true)}
                  className="mt-6 rounded-full bg-gradient-to-b from-gold-hi to-gold px-6 py-2.5 text-sm font-semibold text-black shadow-[0_10px_30px_-14px_var(--gold)]">
                  Start the challenge
                </button>
              </>
            )}
            <p className="mt-6 text-[11px] text-muted">Practice with virtual money on past prices. A good week here says nothing about future prices, and nothing here is advice.</p>
          </section>
          <div className="space-y-4">
            <Leaderboard board={ch.board} title="This week" />
            {ch.last_week && ch.last_week.players > 0 && <Leaderboard board={ch.last_week} title={`Last week (${ch.last_week.week})`} />}
          </div>
        </div>
      )}
    </div>
  );
}
