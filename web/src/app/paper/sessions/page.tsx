"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import ReplayPlayer, { type PlayerState } from "@/components/practice/ReplayPlayer";
import ReplaySummary from "@/components/practice/ReplaySummary";
import SignInPrompt from "@/components/SignInPrompt";
import { toast } from "@/components/Toaster";
import { Chips, Empty, Icon, PageHeader } from "@/components/ui";
import { api, type ReplaySettled, type Session, type SessionSummary, type SessionTf } from "@/lib/api";
import { useUser } from "@/lib/useUser";

const TFS: { key: SessionTf; label: string; higher: string; note: string }[] = [
  { key: "5m", label: "5 min", higher: "with hourly", note: "Minute data covers the last 60 days." },
  { key: "15m", label: "15 min", higher: "with 4-hour", note: "Minute data covers the last 60 days." },
  { key: "1h", label: "1 hour", higher: "with daily", note: "Hourly data goes back to 2003." },
];
const field = "rounded-lg border border-border bg-background px-2.5 py-1.5 text-sm outline-none focus:border-gold";
const SAVE_MS = 1500;

function NewSession({ onMade }: { onMade: (s: Session) => void }) {
  const [tf, setTf] = useState<SessionTf>("1h");
  const [pick, setPick] = useState<"random" | "dates">("random");
  const [start, setStart] = useState("");
  const [end, setEnd] = useState("");
  const [blind, setBlind] = useState(true);
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <form className="card space-y-4 p-4" onSubmit={async (e) => {
      e.preventDefault();
      setBusy(true); setError(null);
      try {
        onMade(await api.newSession({ tf, blind, name, ...(pick === "dates" ? { start, end } : {}) }));
      } catch (err) { setError(err instanceof Error ? err.message : "Couldn't start the session"); }
      finally { setBusy(false); }
    }}>
      <h2 className="flex items-center gap-2 font-medium"><Icon name="clock" className="h-4 w-4 text-gold" />New session</h2>
      <div>
        <p className="mb-1 text-xs text-muted">Candles</p>
        <Chips options={TFS.map((t) => ({ key: t.key, label: `${t.label} ${t.higher}` }))} value={tf} onChange={setTf} />
        <p className="mt-1 text-xs text-muted">{TFS.find((t) => t.key === tf)?.note} A session holds up to 3,000 candles.</p>
      </div>
      <div>
        <p className="mb-1 text-xs text-muted">Dates</p>
        <Chips options={[{ key: "random", label: "Pick a random stretch" }, { key: "dates", label: "Choose dates" }]} value={pick} onChange={setPick} />
        {pick === "dates" && (
          <div className="quiz-in mt-2 flex flex-wrap gap-2">
            <label className="text-xs text-muted">From<input type="date" required value={start} onChange={(e) => setStart(e.target.value)} className={`mt-1 block ${field}`} /></label>
            <label className="text-xs text-muted">To<input type="date" required value={end} onChange={(e) => setEnd(e.target.value)} className={`mt-1 block ${field}`} /></label>
          </div>
        )}
      </div>
      <label className="flex cursor-pointer items-start gap-2 text-sm">
        <input type="checkbox" checked={blind} onChange={(e) => setBlind(e.target.checked)} className="mt-1 accent-[var(--gold)]" />
        <span>Blind mode<span className="block text-xs text-muted">Hides dates and times until you finish, so you trade what you see, not what you remember. Best with a random stretch.</span></span>
      </label>
      <label className="block text-xs text-muted">Name (optional)
        <input value={name} maxLength={60} onChange={(e) => setName(e.target.value)} placeholder="e.g. London breakout test" className={`mt-1 block w-full ${field}`} />
      </label>
      {error && <p role="alert" className="text-sm text-down">{error}</p>}
      <button disabled={busy || (pick === "dates" && (!start || !end))}
        className="w-full rounded-full bg-gradient-to-b from-gold-hi to-gold py-2 text-sm font-semibold text-black disabled:opacity-50">
        {busy ? "Loading candles…" : "Start session"}
      </button>
    </form>
  );
}

function SessionRow({ s, onOpen, onDelete }: { s: SessionSummary; onOpen: () => void; onDelete: () => void }) {
  const [confirm, setConfirm] = useState(false);
  const r = s.result;
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-xl border border-border bg-surface px-3.5 py-2.5 text-sm">
      <span className="font-medium">{s.name || `${s.tf} session`}</span>
      {s.blind && <span className="rounded-full bg-calm/15 px-2 py-0.5 text-[11px] text-calm">Blind</span>}
      <span className="text-xs text-muted">{s.start ? `${s.start} to ${s.end}` : "Dates hidden"} · {s.tf}</span>
      <span className="text-xs text-muted">
        {s.finished && r ? `Finished: ${r.return_pct >= 0 ? "+" : ""}${r.return_pct.toFixed(2)}% over ${r.trades} trades` : `${s.progress.shown} candles in, ${s.progress.trades} trades`}
      </span>
      <div className="ml-auto flex gap-2">
        {!s.finished && <button type="button" onClick={onOpen} className="rounded-lg bg-gold px-3 py-1 text-xs font-medium text-black">Resume</button>}
        {confirm
          ? <button type="button" onClick={onDelete} className="rounded-lg bg-down/15 px-3 py-1 text-xs text-down">Delete it?</button>
          : <button type="button" onClick={() => setConfirm(true)} className="rounded-lg border border-border px-3 py-1 text-xs text-muted hover:text-down" aria-label="Delete session">✕</button>}
      </div>
    </div>
  );
}

export default function SessionsPage() {
  const { user } = useUser();
  const [list, setList] = useState<SessionSummary[] | null>(null);
  const [open, setOpen] = useState<Session | null>(null);
  const [done, setDone] = useState<{ trades: ReplaySettled[]; info: SessionSummary } | null>(null);
  const [saved, setSaved] = useState<"saved" | "saving" | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const latest = useRef<PlayerState | null>(null);

  const refresh = useCallback(() => api.sessions().then(setList, () => setList([])), []);
  useEffect(() => { if (user) refresh(); }, [user, refresh]);

  const flush = useCallback(async () => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
    if (!open || !latest.current) return;
    setSaved("saving");
    try { await api.saveSession(open.id, latest.current); setSaved("saved"); } catch { setSaved(null); }
  }, [open]);
  const onState = useCallback((s: PlayerState) => {
    latest.current = s;
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(flush, SAVE_MS);
  }, [flush]);
  // Save before leaving the page.
  useEffect(() => {
    const h = () => {
      if (!timer.current || !open || !latest.current) return;
      fetch(`/api/practice/sessions/${open.id}`, { method: "PUT", keepalive: true, credentials: "same-origin",
        headers: { "Content-Type": "application/json" }, body: JSON.stringify({ state: latest.current }) }).catch(() => {});
    };
    window.addEventListener("pagehide", h);
    return () => window.removeEventListener("pagehide", h);
  }, [open]);

  if (user === null) return <SignInPrompt what="run and save manual backtesting sessions" next="/paper/sessions" />;
  if (user === undefined) return null;

  async function openSession(id: number) {
    try { setDone(null); setSaved(null); setOpen(await api.session(id)); window.scrollTo({ top: 0, behavior: "smooth" }); }
    catch (e) { toast(e instanceof Error ? e.message : "Couldn't open it", { tone: "down" }); }
  }

  const st = (open?.state ?? {}) as Partial<PlayerState>;
  return (
    <div className="mx-auto max-w-6xl space-y-5 px-4 py-8">
      <PageHeader icon="clock" title="Manual backtesting"
        subtitle="Replay any stretch of gold's history candle by candle, with a higher timeframe beside it. Sessions save as you go, so you can stop and pick up later on any device."
        right={<Link href="/paper/replay" className="flex basis-full justify-center rounded-full border border-border px-4 py-1.5 text-sm hover:border-gold/40 sm:basis-auto">Quick one-day replay</Link>} />

      {open ? (
        <div className="space-y-4">
          <div className="flex flex-wrap items-center gap-3 text-sm">
            <button type="button" onClick={async () => { await flush(); setOpen(null); refresh(); }}
              className="rounded-lg border border-border px-3 py-1.5 hover:border-muted">← All sessions</button>
            <span className="font-medium">{open.name || `${open.tf} session`}</span>
            {open.blind && !done && <span className="rounded-full bg-calm/15 px-2 py-0.5 text-[11px] text-calm">Blind: dates hidden</span>}
            {!done && <span className="ml-auto text-xs text-muted">{saved === "saving" ? "Saving…" : saved === "saved" ? "Progress saved" : "Saves as you go"}</span>}
            {!done && <button type="button" onClick={async () => { await flush(); toast("Saved. Resume it any time from this page.", { tone: "up" }); setOpen(null); refresh(); }}
              className="rounded-lg border border-gold/50 px-3 py-1.5 text-gold hover:bg-gold/10">Pause and save</button>}
          </div>
          <ReplayPlayer key={open.id} bars={open.bars} context={open.context} balance={open.balance} leverage={open.leverage}
            blind={open.blind} higher={open.htf} initial={st} onState={done ? undefined : onState} height={460}
            onFinish={async (trades, settled) => {
              if (timer.current) clearTimeout(timer.current);
              try {
                const info = await api.finishSession(open.id, trades);
                setDone({ trades: settled, info });
                refresh();
              } catch (e) { toast(e instanceof Error ? e.message : "Couldn't finish the session", { tone: "down" }); }
            }} />
          {done && (
            <ReplaySummary done={done.trades} balance={open.balance}>
              {open.blind && done.info.start && (
                <p className="mt-3 text-sm">The dates were <span className="font-medium">{done.info.start} to {done.info.end}</span>.</p>
              )}
              <div className="mt-4 flex gap-2">
                <button type="button" onClick={() => { setOpen(null); setDone(null); }} className="rounded-full bg-gradient-to-b from-gold-hi to-gold px-4 py-1.5 text-sm font-semibold text-black">Start another session</button>
              </div>
            </ReplaySummary>
          )}
        </div>
      ) : (
        <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_340px]">
          <section className="min-w-0 space-y-2">
            <h2 className="font-medium">Your sessions</h2>
            {list == null && <div className="h-24 animate-pulse rounded-2xl bg-surface" />}
            {list?.length === 0 && <Empty icon="clock" title="No sessions yet">Start one on the right. Blind mode with a random stretch is the fairest test of a strategy you trade by hand.</Empty>}
            {list?.map((s) => (
              <SessionRow key={s.id} s={s} onOpen={() => openSession(s.id)}
                onDelete={async () => { await api.deleteSession(s.id).catch(() => {}); refresh(); }} />
            ))}
          </section>
          <NewSession onMade={(s) => { setOpen(s); setDone(null); refresh(); }} />
        </div>
      )}
    </div>
  );
}
