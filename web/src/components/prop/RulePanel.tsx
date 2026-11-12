"use client";

import Link from "next/link";
import ShareButton, { type ShareInput } from "@/components/ShareCard";
import { Icon } from "@/components/ui";
import { fmtUsd, type PropChallenge, type PropCheck, type PropHelp } from "@/lib/api";

const pct = (v: number, d = 1) => `${v > 0 ? "+" : ""}${v.toFixed(d)}%`;

export function phaseName(ch: Pick<PropChallenge, "phase" | "phases">) {
  return ch.phases > 1 ? `Phase ${ch.phase} of ${ch.phases}` : "One phase";
}

export function StatusPill({ status }: { status: PropChallenge["status"] }) {
  const map = {
    active: ["In progress", "border-gold/50 bg-gold/10 text-gold"],
    passed: ["Passed", "border-up/50 bg-up/15 text-up"],
    failed: ["Failed", "border-down/50 bg-down/15 text-down"],
    abandoned: ["Left early", "border-border text-muted"],
  } as const;
  const [label, cls] = map[status];
  return <span className={`inline-flex items-center rounded-full border px-2.5 py-0.5 text-[11px] font-medium ${cls}`}>{label}</span>;
}

function CheckRow({ c }: { c: PropCheck }) {
  const loss = c.key === "daily_loss" || c.key === "max_loss";
  const bar = loss
    ? c.status === "warn" ? "bg-down" : "bg-gold"
    : c.status === "done" ? "bg-up" : "bg-gold";
  const icon = c.status === "done" ? "check" : loss ? "risk" : c.key === "min_days" ? "calendar" : "trophy";
  const value = c.key === "min_days" ? `${c.value} / ${c.limit}`
    : loss ? `${fmtUsd(c.value)} of ${fmtUsd(c.limit)}`
    : `${c.value >= 0 ? "+" : ""}${fmtUsd(c.value)} of ${fmtUsd(c.limit)}`;
  return (
    <div className={`rounded-xl border p-3 ${c.status === "warn" ? "border-down/50 bg-down/5" : c.status === "done" ? "border-up/40 bg-up/5" : "border-border bg-background/40"}`}>
      <div className="flex items-center gap-2 text-sm">
        <Icon name={icon} className={`h-4 w-4 shrink-0 ${c.status === "done" ? "text-up" : c.status === "warn" ? "text-down" : "text-gold"}`} />
        <span className="min-w-0 flex-1 font-medium">{c.label}</span>
      </div>
      <p className="mt-1 text-xs tabular-nums text-muted">{value}{loss ? " used" : ""}</p>
      <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-surface-2" role="progressbar" aria-label={c.label}
        aria-valuenow={Math.round(c.progress)} aria-valuemin={0} aria-valuemax={100}>
        <div className={`h-full rounded-full transition-all duration-500 ${bar}`} style={{ width: `${Math.max(c.progress, c.progress > 0 ? 2 : 0)}%` }} />
      </div>
      <p className="mt-1.5 text-xs text-muted">{c.text}</p>
    </div>
  );
}

export function HelpLink({ help }: { help: PropHelp }) {
  return (
    <span className="text-xs text-muted">
      {help.tip}
      {help.lesson && (
        <> <Link href={`/learn/${help.lesson.id}`} className="whitespace-nowrap text-gold underline-offset-2 hover:underline">
          Lesson: {help.lesson.title} <Icon name="arrow" className="inline h-3 w-3" />
        </Link></>
      )}
    </span>
  );
}

export function certificate(ch: PropChallenge): ShareInput {
  const r = ch.final ?? ch.phase_results[ch.phase_results.length - 1];
  return {
    kind: "Practice challenge passed",
    title: `${ch.label} · ${fmtUsd(ch.size)}`,
    subtitle: `Passed ${ch.phases > 1 ? `both phases` : "the evaluation"} on virtual money${ch.ended_at ? `, ${new Date(ch.ended_at).toLocaleDateString(undefined, { day: "numeric", month: "long", year: "numeric" })}` : ""}`,
    footnote: "A practice evaluation on a paper account with virtual money. Not a funded account or an offer from any firm.",
    equity: [ch.size, ...ch.phase_results.flatMap((p) => [ch.size + p.profit])],
    stats: [
      { label: "Profit", value: r ? pct(r.profit_pct) : "–", tone: "up" },
      { label: "Worst day", value: r ? `${r.worst_daily_pct.toFixed(1)}%` : "–", tone: r && r.worst_daily_pct > 0 ? "down" : undefined },
      { label: "Trading days", value: r ? String(r.trading_days) : "–" },
      { label: "Trades", value: r ? String(r.trades) : "–" },
    ],
  };
}

/** The rules of a running challenge with progress on each, or how an ended one finished. */
export default function RulePanel({ ch, compact = false }: { ch: PropChallenge; compact?: boolean }) {
  return (
    <section aria-label="Prop challenge" className={`rounded-2xl border p-4 ${ch.status === "failed" ? "border-down/50 bg-down/5" : ch.status === "passed" ? "border-up/50 bg-up/5" : "border-gold/40 bg-gradient-to-br from-gold/10 to-transparent"}`}>
      <div className="flex flex-wrap items-center gap-2">
        <Icon name="trophy" className="h-4 w-4 text-gold" />
        <h2 className="font-semibold">Prop challenge</h2>
        <StatusPill status={ch.status} />
        <span className="text-xs text-muted">{ch.label} · {fmtUsd(ch.size)} · 1:{ch.leverage} · {phaseName(ch)}</span>
        {compact && (
          <Link href="/paper/prop" className="ml-auto text-xs text-gold underline-offset-2 hover:underline">Challenge details</Link>
        )}
      </div>

      {ch.status === "active" && ch.checks && (
        <>
          <div className="mt-3 grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
            {ch.checks.map((c) => <CheckRow key={c.key} c={c} />)}
          </div>
          {!!ch.warnings?.length && (
            <ul className="mt-3 space-y-1.5">
              {ch.warnings.map((w) => (
                <li key={w.key} role="alert" className="flex gap-2 rounded-xl border border-down/40 bg-down/5 px-3 py-2 text-sm">
                  <span className="breathe mt-1.5 h-2 w-2 shrink-0 rounded-full bg-down" />
                  <span><b className="font-medium">{w.text}</b> <HelpLink help={w} /></span>
                </li>
              ))}
            </ul>
          )}
          {!compact && ch.phase > 1 && ch.phase_results.length > 0 && (
            <p className="mt-3 text-xs text-muted">
              Phase 1 passed with {pct(ch.phase_results[0].profit_pct)} in {ch.phase_results[0].trading_days} trading day{ch.phase_results[0].trading_days === 1 ? "" : "s"}. This phase started on a fresh {fmtUsd(ch.size)} account.
            </p>
          )}
        </>
      )}

      {ch.status === "failed" && (
        <div className="mt-3 space-y-2 text-sm">
          <p><b className="text-down">The {ch.fail_rule === "daily_loss" ? "daily loss limit" : "maximum loss limit"} was broken.</b> {ch.fail_detail} Open positions were closed and pending orders cancelled.</p>
          {ch.fail_help && <p><HelpLink help={ch.fail_help} /></p>}
          {compact && <Link href="/paper/prop" className="inline-block rounded-full bg-gradient-to-b from-gold-hi to-gold px-4 py-1.5 text-xs font-semibold text-black">Try again</Link>}
        </div>
      )}

      {ch.status === "passed" && (
        <div className="mt-3 flex flex-wrap items-center gap-3 text-sm">
          <p className="min-w-0 flex-1"><b className="text-up">You passed.</b> {ch.final ? `${pct(ch.final.profit_pct)} with the worst day at ${ch.final.worst_daily_pct.toFixed(1)}% of the account, over ${ch.final.trading_days} trading day${ch.final.trading_days === 1 ? "" : "s"}.` : ""}</p>
          <ShareButton data={certificate(ch)} />
        </div>
      )}
    </section>
  );
}
