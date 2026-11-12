"use client";

import Link from "next/link";
import { use, useEffect, useState } from "react";
import { NextLevel, PassportBadge, RecordStatsGrid } from "@/components/record/Passport";
import { Icon, SidePill } from "@/components/ui";
import { api, type VerifiedReport } from "@/lib/api";

const day = (iso: string) => new Date(iso).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });

export default function VerifyPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const [v, setV] = useState<VerifiedReport | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => { api.recordVerify(id).then(setV, (e) => setError(e instanceof Error ? e.message : "Couldn't check this report")); }, [id]);

  if (error) return <div className="mx-auto max-w-md px-4 py-16 text-center text-muted">{error}</div>;
  if (!v) return <div className="mx-auto max-w-4xl px-4 py-8"><div className="h-72 animate-pulse rounded-2xl bg-surface" /></div>;

  const ok = v.status === "verified";
  const banner = ok
    ? { tone: "border-up/50 bg-up/10 text-up", title: "Verified by Trading Lab", body: "The ledger behind this report is intact and the numbers match it. Nothing has been changed since it was issued." }
    : v.status === "revoked"
      ? { tone: "border-border bg-surface text-muted", title: "Withdrawn", body: "The trader has withdrawn this report, so its numbers are no longer shown." }
      : { tone: "border-down/50 bg-down/10 text-down", title: "Does not check out", body: "Something in this report or the ledger behind it has changed since it was issued. Don't rely on it." };

  return (
    <div className="mx-auto max-w-4xl px-4 py-8">
      <div className={`flex items-start gap-3 rounded-2xl border p-4 ${banner.tone}`}>
        <Icon name={ok ? "seal" : "risk"} className="mt-0.5 h-6 w-6 shrink-0" />
        <div>
          <p className="font-semibold">{banner.title}</p>
          <p className="text-sm text-foreground/80">{banner.body}</p>
        </div>
      </div>

      <div className="mt-6 flex flex-wrap items-end justify-between gap-2">
        <div>
          <p className="text-xs uppercase tracking-wide text-muted">Practice track record</p>
          <h1 className="text-2xl font-semibold tracking-tight">{v.display_name}</h1>
        </div>
        <p className="text-sm text-muted">Issued {day(v.issued_at)}</p>
      </div>

      {v.stats && v.passport && (
        <>
          <section className="mt-4 rounded-2xl border border-gold/40 bg-gradient-to-br from-gold/10 to-transparent p-5">
            <PassportBadge level={v.passport.level} size="lg" />
            <div className="mt-5"><RecordStatsGrid s={v.stats} /></div>
            <p className="mt-3 text-xs text-muted">
              {v.stats.first && v.stats.last ? `Trades from ${day(v.stats.first)} to ${day(v.stats.last)}` : ""}
              {v.stats.markets.length ? ` in ${v.stats.markets.map(([m]) => m).join(", ")}` : ""}.
              {v.stats.resets ? ` The account was started over ${v.stats.resets} time${v.stats.resets === 1 ? "" : "s"}; every trade before that still counts.` : ""}
              {v.stats.agent_trades ? ` ${v.stats.agent_trades} trades by an automated strategy are left out.` : ""}
            </p>
          </section>

          <div className="mt-4 grid gap-4 md:grid-cols-2">
            <section className="card p-4"><NextLevel next={v.passport.next} /></section>
            <section className="card p-4 text-sm">
              <h2 className="font-medium">How this is checked</h2>
              <ul className="mt-2 space-y-1.5">
                {([
                  ["chain", "Ledger chain intact", `${v.entries} entries, each sealed with the fingerprint of the one before`],
                  ["signature", "Signed by Trading Lab", "the report's numbers match what was signed when it was issued"],
                  ["stats", "Numbers recomputed", "the stats were worked out again from the ledger just now"],
                ] as const).map(([k, label, how]) => (
                  <li key={k} className="flex items-start gap-2">
                    <span className={`mt-0.5 ${v.checks?.[k] ? "text-up" : "text-down"}`}><Icon name={v.checks?.[k] ? "check" : "risk"} className="h-4 w-4" /></span>
                    <span>{label}<span className="block text-xs text-muted">{how}</span></span>
                  </li>
                ))}
              </ul>
              <p className="mt-3 break-all text-[11px] text-muted">Ledger fingerprint {v.head_hash}</p>
            </section>
          </div>

          {v.trades && v.trades.length > 0 && (
            <section className="mt-4">
              <h2 className="font-medium">Trades <span className="text-sm font-normal text-muted">(newest first, as % of the account at the time)</span></h2>
              <div className="mt-2 space-y-1.5">
                {v.trades.map((t) => (
                  <div key={t.seq} className={`flex flex-wrap items-center gap-x-3 gap-y-1 rounded-lg border border-border bg-surface px-3 py-2 text-sm ${t.agent ? "opacity-60" : ""}`}>
                    <SidePill side={t.side} />
                    <span className="text-muted">{t.symbol}</span>
                    <span className="text-xs text-muted">{new Date(t.closed_at).toLocaleString(undefined, { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })}</span>
                    {!t.stop && <span className="rounded-full bg-down/15 px-2 py-0.5 text-[11px] text-down">No stop</span>}
                    {t.agent && <span className="rounded-full bg-surface-2 px-2 py-0.5 text-[11px] text-muted">Agent</span>}
                    <span className={`ml-auto tabular-nums ${t.pct >= 0 ? "text-up" : "text-down"}`}>{t.pct > 0 ? "+" : ""}{t.pct.toFixed(2)}%</span>
                  </div>
                ))}
              </div>
            </section>
          )}
        </>
      )}

      <div className="mt-8 rounded-2xl border border-border p-5 text-sm">
        <p className="text-muted">Simulated money only. This shows how someone practised on real market prices, not what they would earn with real money, and it isn&apos;t investment advice.</p>
        <Link href="/record" className="mt-3 inline-flex items-center gap-1.5 text-gold hover:underline">Build your own verified record <Icon name="arrow" className="h-4 w-4" /></Link>
      </div>
    </div>
  );
}
