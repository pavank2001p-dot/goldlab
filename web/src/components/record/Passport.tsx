import { Icon } from "@/components/ui";
import type { Passport, PassportLevel, RecordStats } from "@/lib/api";

const TONE: Record<string, string> = { bronze: "#c58b5a", silver: "#aab4c3", gold: "#d9a92e" };

/** The Skill Passport badge: the level earned, or "Not yet ranked". */
export function PassportBadge({ level, size = "md" }: { level: PassportLevel | null; size?: "md" | "lg" }) {
  const tone = level ? TONE[level.key] : "var(--muted)";
  const box = size === "lg" ? "h-20 w-20" : "h-14 w-14";
  return (
    <div className="flex items-center gap-4">
      <span className={`relative flex ${box} shrink-0 items-center justify-center rounded-full border-2`}
        style={{ borderColor: tone, color: tone, background: `color-mix(in srgb, ${tone} 14%, transparent)` }}>
        <Icon name="seal" className={size === "lg" ? "h-10 w-10" : "h-7 w-7"} />
      </span>
      <div>
        <p className="text-xs uppercase tracking-wide text-muted">Skill Passport</p>
        <p className={`${size === "lg" ? "text-2xl" : "text-lg"} font-semibold`} style={{ color: level ? tone : undefined }}>
          {level ? `${level.name} · ${level.title}` : "Not yet ranked"}
        </p>
        <p className="text-sm text-muted">{level ? level.blurb : "Bronze needs 20 trades of your own with stops on most of them."}</p>
      </div>
    </div>
  );
}

/** Checks for the next level, ticked where they already pass. */
export function NextLevel({ next }: { next: PassportLevel | null }) {
  if (!next) return <p className="text-sm text-up">Top level reached. Keep the record clean to hold it.</p>;
  return (
    <div>
      <div className="flex items-baseline justify-between gap-2">
        <p className="font-medium">Next: {next.name} · {next.title}</p>
        <p className="text-xs text-muted tabular-nums">{next.done} of {next.total}</p>
      </div>
      <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-border">
        <div className="h-full rounded-full bg-gold" style={{ width: `${(next.done / next.total) * 100}%` }} />
      </div>
      <ul className="mt-3 space-y-1.5 text-sm">
        {next.checks.map((c) => (
          <li key={c.key} className="flex items-start gap-2">
            <span className={`mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded-full border ${c.ok ? "border-up bg-up/15 text-up" : "border-border text-transparent"}`}>
              <Icon name="check" className="h-3 w-3" strokeWidth={2.5} />
            </span>
            <span className={c.ok ? "" : "text-muted"}>{c.label} <span className="text-xs text-muted">({c.now})</span></span>
          </li>
        ))}
      </ul>
    </div>
  );
}

const signedPct = (v: number | null | undefined) => (v == null ? "–" : `${v > 0 ? "+" : ""}${v.toFixed(2)}%`);

/** The record's headline numbers. Returns are per trade on the balance at the time, compounded. */
export function RecordStatsGrid({ s }: { s: RecordStats }) {
  const items: [string, string, string?][] = [
    ["Trades", `${s.trades}`, `${s.days} trading day${s.days === 1 ? "" : "s"}`],
    ["Return", signedPct(s.return_pct), "compounded, per trade"],
    ["Deepest drop", s.max_dd ? `-${s.max_dd.toFixed(2)}%` : "0%", "from a high"],
    ["Won", s.trades ? `${s.win_rate_pct}%` : "–"],
    ["Profit factor", s.profit_factor == null ? "–" : s.profit_factor >= 99 ? "no losses" : s.profit_factor.toFixed(2)],
    ["Largest loss", s.worst_loss ? `-${s.worst_loss.toFixed(2)}%` : "–", "of the account"],
    ["With a stop", s.trades ? `${s.stop_pct}%` : "–"],
    ["Prop challenges", `${s.prop_passed} passed`, s.prop_failed ? `${s.prop_failed} failed` : undefined],
  ];
  return (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
      {items.map(([l, v, h]) => (
        <div key={l} className="rounded-xl bg-surface p-3">
          <p className="text-xs text-muted">{l}</p>
          <p className="mt-0.5 text-lg font-semibold tabular-nums">{v}</p>
          {h && <p className="text-[11px] text-muted">{h}</p>}
        </div>
      ))}
    </div>
  );
}

export function levelsLegend(p: Passport) {
  return p.levels.map((l) => `${l.name} (${l.title})`).join(", ");
}
