"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import SignInPrompt from "@/components/SignInPrompt";
import { NextLevel, PassportBadge, RecordStatsGrid } from "@/components/record/Passport";
import { toast } from "@/components/Toaster";
import { Empty, Icon, PageHeader } from "@/components/ui";
import { api, type RecordOverview } from "@/lib/api";
import { useUser } from "@/lib/useUser";

const short = (h: string | null | undefined) => (h ? `${h.slice(0, 10)}…` : "–");
const when = (iso: string | null) => (iso ? new Date(iso).toLocaleString(undefined, { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }) : "");

export default function RecordPage() {
  const { user } = useUser();
  const [r, setR] = useState<RecordOverview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const load = useCallback(() => api.record().then(setR, (e) => setError(e instanceof Error ? e.message : "Couldn't load the record")), []);
  useEffect(() => { if (user) load(); }, [user, load]);
  useEffect(() => { if (user?.name) setName(user.name); }, [user]);

  if (user === null) return <SignInPrompt what="build a verified track record" next="/record" />;
  if (user === undefined) return null;

  const link = (id: string) => `${window.location.origin}/verify/${id}`;
  const copy = async (id: string) => {
    try { await navigator.clipboard.writeText(link(id)); toast("Link copied", { tone: "up" }); }
    catch { toast(link(id)); }
  };
  const issue = async () => {
    setBusy(true);
    try { const rep = await api.recordIssue(name); await load(); copy(rep.id); }
    catch (e) { toast(e instanceof Error ? e.message : "Couldn't issue the report", { tone: "down" }); }
    finally { setBusy(false); }
  };

  return (
    <div className="mx-auto max-w-6xl px-4 py-8">
      <PageHeader icon="seal" title="Verified record"
        subtitle="Every paper trade you close is sealed into a ledger that can't be edited, and starting over doesn't erase it. Share a signed report that anyone can check, to show a teacher, a prop firm or an employer how you really trade." />
      {error && <p className="mt-4 text-sm text-down">{error}</p>}
      {!r && !error && <div className="mt-6 h-72 animate-pulse rounded-2xl bg-surface" />}
      {r && (
        <div className="mt-6 grid gap-6 lg:grid-cols-[minmax(0,1fr)_360px]">
          <div className="min-w-0 space-y-4">
            <section className="rounded-2xl border border-gold/40 bg-gradient-to-br from-gold/10 to-transparent p-5">
              <PassportBadge level={r.passport.level} />
              <div className="mt-5"><RecordStatsGrid s={r.stats} /></div>
              {r.stats.agent_trades > 0 && (
                <p className="mt-3 text-xs text-muted">{r.stats.agent_trades} trade{r.stats.agent_trades === 1 ? "" : "s"} by the strategy agent are sealed too, but left out of these numbers: they show the strategy&apos;s skill, not yours.</p>
              )}
            </section>
            {r.stats.trades === 0 && (
              <Empty icon="wallet" title="Nothing sealed yet">
                Close a trade in <Link href="/paper" className="text-gold hover:underline">paper trading</Link> and it lands here, sealed. Every trade counts, good and bad, so the record shows how you really trade.
              </Empty>
            )}
            <section className="card p-4">
              <h2 className="flex items-center gap-2 font-medium"><Icon name="layers" className="h-4 w-4 text-gold" />The ledger</h2>
              <p className="mt-1 text-sm text-muted">
                {r.chain.ok
                  ? <>{r.chain.entries} sealed entries, chain intact. Each one carries the fingerprint of the one before, so changing any entry breaks every fingerprint after it.</>
                  : <span className="text-down">The chain doesn&apos;t check out at entry {r.chain.broken_at}. Reports can&apos;t be issued until support looks at it.</span>}
              </p>
              <ul className="mt-3 divide-y divide-border text-sm">
                {r.recent.map((e) => (
                  <li key={e.seq} className="flex flex-wrap items-center gap-x-3 gap-y-0.5 py-2">
                    <span className="w-10 text-xs text-muted tabular-nums">#{e.seq}</span>
                    <span className="min-w-0 flex-1">{e.summary}</span>
                    <span className="text-xs text-muted">{when(e.at)}</span>
                    <code className="w-full pl-[52px] text-[11px] text-muted sm:w-auto sm:pl-0" title={e.hash}>{short(e.hash)}</code>
                  </li>
                ))}
              </ul>
            </section>
          </div>

          <aside className="space-y-4">
            <section className="card p-4"><NextLevel next={r.passport.next} /></section>
            <section className="card p-4">
              <h2 className="font-medium">Share a verified report</h2>
              <p className="mt-1 text-sm text-muted">A snapshot of the record as it is now, signed by Trading Lab. The link shows the name below, never your email.</p>
              <label className="mt-3 block text-xs text-muted" htmlFor="rname">Name on the report</label>
              <input id="rname" value={name} maxLength={60} onChange={(e) => setName(e.target.value)} placeholder="A Trading Lab trader"
                className="mt-1 w-full rounded-lg border border-border bg-background px-3 py-2 text-sm outline-none focus:border-gold" />
              <button type="button" disabled={busy || !r.stats.trades || !r.chain.ok} onClick={issue}
                className="mt-3 w-full rounded-lg bg-gold px-3 py-2 text-sm font-medium text-black disabled:opacity-50">
                {busy ? "Signing…" : "Issue report and copy link"}
              </button>
              {r.reports.length > 0 && (
                <ul className="mt-4 space-y-2 text-sm">
                  {r.reports.map((rep) => (
                    <li key={rep.id} className={`rounded-lg border border-border p-2.5 ${rep.revoked ? "opacity-60" : ""}`}>
                      <div className="flex items-center gap-2">
                        <span className="font-medium">{rep.level ?? "Unranked"}</span>
                        <span className="text-xs text-muted">{rep.trades} trades · {new Date(rep.issued_at).toLocaleDateString()}</span>
                        {rep.revoked && <span className="ml-auto text-xs text-down">Withdrawn</span>}
                      </div>
                      {!rep.revoked && (
                        <div className="mt-1.5 flex gap-3 text-xs">
                          <Link href={`/verify/${rep.id}`} className="text-gold hover:underline">Open</Link>
                          <button type="button" onClick={() => copy(rep.id)} className="text-gold hover:underline">Copy link</button>
                          <button type="button" className="ml-auto text-muted hover:text-down" onClick={async () => {
                            try { await api.recordRevoke(rep.id); await load(); toast("Report withdrawn"); }
                            catch (e) { toast(e instanceof Error ? e.message : "Couldn't withdraw", { tone: "down" }); }
                          }}>Withdraw</button>
                        </div>
                      )}
                    </li>
                  ))}
                </ul>
              )}
            </section>
            <p className="px-1 text-xs text-muted">Simulated money only. A verified record shows how someone practised, not what they would earn with real money.</p>
          </aside>
        </div>
      )}
    </div>
  );
}
