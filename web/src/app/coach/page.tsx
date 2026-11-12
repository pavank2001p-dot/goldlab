"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import SignInPrompt from "@/components/SignInPrompt";
import TagChips from "@/components/coach/TagChips";
import { GlyphWall, TwinCard } from "@/components/coach/Twin";
import { Empty, Icon, PageHeader, SidePill } from "@/components/ui";
import { toast } from "@/components/Toaster";
import { api, fmtUsd, type CoachTag, type CoachTags, type CoachWeek, type Playbook, type Twin } from "@/lib/api";
import { useUser } from "@/lib/useUser";

/** ISO week ("2026-W46") of a date, and the week `n` weeks after it. */
function isoWeek(d: Date): string {
  const t = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const day = t.getUTCDay() || 7;
  t.setUTCDate(t.getUTCDate() + 4 - day);
  const y = t.getUTCFullYear();
  const w = Math.ceil(((t.getTime() - Date.UTC(y, 0, 1)) / 86400000 + 1) / 7);
  return `${y}-W${String(w).padStart(2, "0")}`;
}
function mondayOf(week: string): Date {
  const [y, w] = [Number(week.slice(0, 4)), Number(week.slice(6))];
  const jan4 = new Date(Date.UTC(y, 0, 4));
  const mon = new Date(jan4);
  mon.setUTCDate(jan4.getUTCDate() - ((jan4.getUTCDay() || 7) - 1) + (w - 1) * 7);
  return mon;
}
const shift = (week: string, n: number) => isoWeek(new Date(mondayOf(week).getTime() + n * 7 * 86400000));
const span = (week: string) => {
  const a = mondayOf(week), b = new Date(a.getTime() + 6 * 86400000);
  const f = (d: Date) => d.toLocaleDateString(undefined, { day: "numeric", month: "short", timeZone: "UTC" });
  return `${f(a)} to ${f(b)}`;
};
const signed = (v: number) => `${v > 0 ? "+" : ""}${fmtUsd(v)}`;

function Report({ w, labels }: { w: CoachWeek; labels?: CoachTags["labels"] }) {
  const t = w.facts.this_week, p = w.facts.week_before;
  const tags = Object.entries(t.tags) as [CoachTag, number][];
  return (
    <div className="space-y-4">
      <div className="rounded-2xl border border-gold/40 bg-gradient-to-br from-gold/10 to-transparent p-5">
        <p className="text-xs uppercase tracking-wide text-gold">{w.finished ? "Week in review" : "This week so far"}{w.source === "ai" ? " · written by the AI coach" : ""}</p>
        <h2 className="mt-1 text-xl font-semibold">{w.headline}</h2>
        <div className="mt-4 grid grid-cols-2 gap-3 text-sm sm:grid-cols-4">
          {[
            ["Trades", `${t.trades}`, p.trades ? `${p.trades} the week before` : ""],
            ["Without a mistake", t.trades ? `${t.clean_trades} of ${t.trades}` : "–", p.trades ? `${p.clean_trades} of ${p.trades} before` : ""],
            ["Won", t.win_rate_pct != null ? `${t.win_rate_pct}%` : "–", ""],
            ["Closed profit / loss", t.trades ? signed(t.net) : "–", "Process matters more than this"],
          ].map(([l, v, h]) => (
            <div key={l} className="rounded-xl bg-surface p-3">
              <p className="text-xs text-muted">{l}</p>
              <p className="mt-0.5 text-lg font-semibold tabular-nums">{v}</p>
              {h && <p className="text-[11px] text-muted">{h}</p>}
            </div>
          ))}
        </div>
      </div>

      <div className="grid gap-4 md:grid-cols-2">
        <section className="card p-4">
          <h3 className="flex items-center gap-2 font-medium"><Icon name="check" className="h-4 w-4 text-up" />What went well</h3>
          {w.went_well.length ? (
            <ul className="mt-2 space-y-1.5 text-sm text-muted">{w.went_well.map((g) => <li key={g}>{g}</li>)}</ul>
          ) : <p className="mt-2 text-sm text-muted">Nothing to point to yet.</p>}
        </section>
        <section className="card border-gold/40 p-4">
          <h3 className="flex items-center gap-2 font-medium"><Icon name="bolt" className="h-4 w-4 text-gold" />Work on this</h3>
          <p className="mt-2 text-sm text-muted">{w.work_on}</p>
          <p className="mt-3 rounded-lg bg-background p-3 text-sm"><span className="text-gold">Goal for next week: </span>{w.next_week_goal}</p>
        </section>
      </div>

      {tags.length > 0 && (
        <section className="card p-4">
          <h3 className="font-medium">Mistakes the coach tagged</h3>
          <div className="mt-3 space-y-2">
            {tags.sort((a, b) => b[1] - a[1]).map(([k, n]) => (
              <div key={k} className="flex items-center gap-3 text-sm">
                <span className="w-36 shrink-0">{labels?.[k]?.label ?? k}</span>
                <div className="h-2 flex-1 overflow-hidden rounded-full bg-border">
                  <div className="h-full rounded-full bg-down" style={{ width: `${(n / Math.max(t.trades, 1)) * 100}%` }} />
                </div>
                <span className="w-16 text-right tabular-nums text-muted">{n}{p.tags[k] != null ? ` (${p.tags[k]})` : ""}</span>
              </div>
            ))}
          </div>
          <p className="mt-2 text-xs text-muted">Bracketed numbers are the week before.</p>
        </section>
      )}

      {w.trades.length > 0 && (
        <section className="space-y-2">
          <h3 className="font-medium">The week&apos;s trades</h3>
          {w.trades.map((tr) => (
            <div key={tr.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-lg border border-border bg-surface px-3.5 py-2.5 text-sm">
              <SidePill side={tr.side} />
              <span className="text-muted">{tr.symbol}</span>
              <span className="text-xs text-muted">{new Date(tr.closed_at).toLocaleString(undefined, { weekday: "short", hour: "2-digit", minute: "2-digit" })}</span>
              <TagChips tags={tr.tags} labels={labels} />
              {!tr.tags.length && <span className="rounded-full bg-up/15 px-2 py-0.5 text-[11px] text-up">Clean</span>}
              <span className={`ml-auto tabular-nums ${tr.pnl >= 0 ? "text-up" : "text-down"}`}>{signed(tr.pnl)}</span>
            </div>
          ))}
        </section>
      )}
    </div>
  );
}

function PlaybookEditor() {
  const [pb, setPb] = useState<Playbook | null>(null);
  const [rules, setRules] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  useEffect(() => { api.coachPlaybook().then((p) => { setPb(p); setRules(p.rules); }, () => {}); }, []);
  if (!pb) return <div className="h-40 animate-pulse rounded-2xl bg-surface" />;
  const dirty = JSON.stringify(rules) !== JSON.stringify(pb.rules) || !pb.custom;
  return (
    <section className="card p-4">
      <h2 className="flex items-center gap-2 font-medium"><Icon name="book" className="h-4 w-4 text-gold" />Your playbook</h2>
      <p className="mt-1 text-xs text-muted">Your own rules. They show as a checklist each time you review an order in paper trading.{pb.custom ? "" : " These are starters; change them to your own."}</p>
      <ol className="mt-3 space-y-2">
        {rules.map((r, i) => (
          <li key={i} className="flex gap-2">
            <span className="mt-2 w-4 text-xs text-muted tabular-nums">{i + 1}.</span>
            <textarea value={r} maxLength={140} rows={2} onChange={(e) => setRules(rules.map((x, j) => (j === i ? e.target.value.replace(/\n/g, " ") : x)))}
              className="w-full resize-none rounded-lg border border-border bg-background px-3 py-2 text-sm outline-none focus:border-gold" aria-label={`Rule ${i + 1}`} />
            <button type="button" onClick={() => setRules(rules.filter((_, j) => j !== i))} className="px-2 text-muted hover:text-down" aria-label={`Remove rule ${i + 1}`}>✕</button>
          </li>
        ))}
      </ol>
      <div className="mt-3 flex flex-wrap gap-2">
        {rules.length < pb.max && (
          <button type="button" onClick={() => setRules([...rules, ""])} className="rounded-lg border border-border px-3 py-1.5 text-xs hover:border-muted">Add a rule</button>
        )}
        <button type="button" disabled={busy || !dirty} onClick={async () => {
          setBusy(true);
          try { const p = await api.coachSavePlaybook(rules); setPb(p); setRules(p.rules); toast("Playbook saved", { tone: "up" }); }
          catch (e) { toast(e instanceof Error ? e.message : "Couldn't save", { tone: "down" }); }
          finally { setBusy(false); }
        }} className="ml-auto rounded-lg bg-gold px-3 py-1.5 text-xs font-medium text-black disabled:opacity-50">Save playbook</button>
      </div>
    </section>
  );
}

export default function CoachPage() {
  const { user } = useUser();
  const thisWeek = isoWeek(new Date());
  const [week, setWeek] = useState(thisWeek);
  const [w, setW] = useState<CoachWeek | null>(null);
  const [tags, setTags] = useState<CoachTags | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!user) return;
    setW(null);
    setError(null);
    api.coachWeek(week).then(setW, (e) => setError(e instanceof Error ? e.message : "Couldn't load the report"));
  }, [user, week]);
  const [twin, setTwin] = useState<Twin | null>(null);
  useEffect(() => { if (user) api.coachTags().then(setTags, () => {}); }, [user]);
  useEffect(() => { if (user) api.coachTwin().then(setTwin, () => {}); }, [user]);
  if (user === null) return <SignInPrompt what="get coaching on your own practice trades" next="/coach" />;
  if (user === undefined) return null;
  const total = tags ? (Object.values(tags.counts).reduce((a, b) => a + b, 0)) : 0;
  return (
    <div className="mx-auto max-w-6xl px-4 py-8">
      <PageHeader icon="check" title="Coach"
        subtitle="The coach reads your paper trades, tags the mistakes that cost traders most, and writes a weekly report. It grades your process, never your profit, and never says where prices will go." />
      <div className="mt-6 grid gap-6 lg:grid-cols-[minmax(0,1fr)_340px]">
        <div className="min-w-0 space-y-4">
          <div className="flex items-center gap-2">
            <button type="button" onClick={() => setWeek(shift(week, -1))} className="rounded-lg border border-border px-3 py-1.5 text-sm hover:border-muted" aria-label="Previous week">←</button>
            <p className="text-sm"><span className="font-medium">{week === thisWeek ? "This week" : week}</span> <span className="text-muted">· {span(week)}</span></p>
            <button type="button" disabled={week >= thisWeek} onClick={() => setWeek(shift(week, 1))} className="rounded-lg border border-border px-3 py-1.5 text-sm hover:border-muted disabled:opacity-40" aria-label="Next week">→</button>
          </div>
          {error && <p className="text-sm text-down">{error}</p>}
          {!w && !error && <div className="h-64 animate-pulse rounded-2xl bg-surface" />}
          {w && (w.facts.this_week.trades === 0 && w.facts.week_before.trades === 0 && tags?.trades === 0 ? (
            <Empty icon="wallet" title="No paper trades to coach yet">
              Close a few trades in <Link href="/paper" className="text-gold hover:underline">paper trading</Link> and the coach will tag them and write your week up.
            </Empty>
          ) : <Report w={w} labels={tags?.labels} />)}
          {twin && <TwinCard t={twin} />}
          {twin && <GlyphWall days={twin.days} />}
        </div>
        <aside className="space-y-4">
          <PlaybookEditor />
          {tags && tags.trades > 0 && (
            <section className="card p-4 text-sm">
              <h2 className="font-medium">All your paper trades</h2>
              <p className="mt-1 text-muted">{tags.clean} of {tags.trades} had no mistake tagged.</p>
              <ul className="mt-3 space-y-2">
                {(Object.keys(tags.labels) as CoachTag[]).map((k) => (
                  <li key={k} className="flex items-start gap-2" title={tags.labels[k].explain}>
                    <span className="flex-1">{tags.labels[k].label}<span className="block text-xs text-muted">{tags.labels[k].explain}</span></span>
                    <span className={`tabular-nums ${tags.counts[k] ? "text-down" : "text-muted"}`}>{tags.counts[k]}</span>
                  </li>
                ))}
              </ul>
              {total === 0 && <p className="mt-3 text-up">Nothing tagged so far. Keep it up.</p>}
            </section>
          )}
        </aside>
      </div>
    </div>
  );
}
