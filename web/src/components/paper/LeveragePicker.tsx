"use client";

import { fmtUsd } from "@/lib/api";

export const shortUsd = (v: number) =>
  v >= 1e12 ? `$${+(v / 1e12).toFixed(2)}T` : v >= 1e9 ? `$${+(v / 1e9).toFixed(2)}B` : v >= 1e6 ? `$${+(v / 1e6).toFixed(2)}M` : v >= 1e3 ? `$${+(v / 1e3).toFixed(1)}k` : `$${v}`;

/** Leverage grouped the way brokers present it, from none to the high ratios offshore accounts offer. */
export const TIERS: { label: string; note: string; tone: string; levels: number[] }[] = [
  { label: "No leverage", note: "Like owning gold outright", tone: "var(--up)", levels: [1] },
  { label: "Regulated retail", note: "EU, UK and Australian brokers cap gold at 1:20 for retail clients", tone: "var(--calm)", levels: [2, 5, 10, 20] },
  { label: "Typical offshore", note: "Common at brokers outside those rules", tone: "var(--gold)", levels: [30, 50, 100, 200] },
  { label: "Very high", note: "Small moves can wipe out the account", tone: "var(--down)", levels: [300, 500, 1000] },
];

export function tierOf(l: number) {
  return TIERS.find((t) => t.levels.includes(l)) ?? (l <= 20 ? TIERS[1] : l <= 200 ? TIERS[2] : TIERS[3]);
}

/** Tiered leverage buttons with a worked example of what the chosen ratio means for this account. */
export default function LeveragePicker({ value, onPick, balance, price, stopOut = 50, marginCall = 100, disabled }: {
  value: number; onPick: (l: number) => void; balance: number; price: number; stopOut?: number; marginCall?: number; disabled?: boolean;
}) {
  const t = tierOf(value);
  const control = balance * value;
  const oz = control / price;
  // A position using all the margin is stopped out once losses eat (1 - stopOut%) of the account.
  const wipe = ((1 - stopOut / 100) / value) * 100;
  return (
    <div>
      <div className="grid gap-2 sm:grid-cols-2">
        {TIERS.map((tier) => (
          <div key={tier.label} className="rounded-xl border border-border bg-background/50 p-2.5">
            <p className="flex items-center gap-1.5 text-xs font-medium">
              <span className="h-1.5 w-1.5 rounded-full" style={{ background: tier.tone }} />{tier.label}
            </p>
            <div className="mt-2 flex flex-wrap gap-1.5">
              {tier.levels.map((l) => (
                <button key={l} type="button" disabled={disabled} onClick={() => onPick(l)} aria-pressed={value === l}
                  className={`rounded-full border px-2.5 py-1 text-xs font-medium tabular-nums transition disabled:opacity-50 ${value === l ? "text-foreground" : "border-border text-muted hover:text-foreground"}`}
                  style={value === l ? { borderColor: tier.tone, background: `color-mix(in srgb, ${tier.tone} 18%, transparent)` } : undefined}>
                  1:{l}
                </button>
              ))}
            </div>
          </div>
        ))}
      </div>
      <div className="mt-3 rounded-xl border p-3 text-xs leading-relaxed" style={{ borderColor: `color-mix(in srgb, ${t.tone} 40%, transparent)`, background: `color-mix(in srgb, ${t.tone} 7%, transparent)` }}>
        <p className="font-semibold" style={{ color: t.tone }}>1:{value} · {t.label}</p>
        <p className="mt-1 text-muted">{t.note}.</p>
        <ul className="mt-2 space-y-1 text-foreground/90">
          <li>With {shortUsd(balance)} you can control up to <b>{fmtUsd(control)}</b> of gold (about {oz >= 100 ? Math.round(oz).toLocaleString("en-US") : oz.toFixed(2)} oz).</li>
          <li>At full size, a <b>{wipe < 1 ? wipe.toFixed(2) : wipe.toFixed(1)}%</b> move against you would trigger the stop-out.</li>
          <li>Below {marginCall}% margin level you get a margin call and can&apos;t open new trades; at {stopOut}% positions close automatically.</li>
        </ul>
      </div>
    </div>
  );
}
