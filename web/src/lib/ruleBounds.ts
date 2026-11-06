import type { Operand, Rules } from "./api";

// Fixed, sensible ranges for each setting. They never depend on the current value, so a slider
// can't stretch its own range each time it reaches the end.
const N: Record<string, [number, number]> = {
  sma: [2, 250], ema: [2, 250], highest: [2, 200], lowest: [2, 200], roc: [1, 100],
  adx: [5, 50], plus_di: [5, 50], minus_di: [5, 50], rsi: [2, 50], stoch: [5, 50], williams_r: [5, 50],
  cci: [5, 100], atr_pct: [5, 50], bb_upper: [5, 100], bb_lower: [5, 100], macd: [2, 50], macd_signal: [2, 50],
};
const M: Record<string, [number, number, number]> = { // min, max, step
  macd: [5, 120, 1], macd_signal: [5, 120, 1], bb_upper: [0.5, 4, 0.1], bb_lower: [0.5, 4, 0.1],
};
// Levels for indicators that live on a fixed scale.
const LEVEL: Record<string, [number, number]> = {
  rsi: [0, 100], stoch: [0, 100], adx: [0, 60], plus_di: [0, 60], minus_di: [0, 60], williams_r: [-100, 0],
  cci: [-300, 300], roc: [-20, 20], atr_pct: [0, 10],
};

export const nRange = (ind: string): [number, number] => N[ind] ?? [2, 200];
export const mRange = (ind: string): [number, number, number] => M[ind] ?? [2, 120, 1];
export const levelRange = (ind: string): [number, number] | null => LEVEL[ind] ?? null;

export const clamp = (v: number, lo: number, hi: number) => (Number.isFinite(v) ? Math.min(Math.max(v, lo), hi) : lo);

/** Brings every number in an operand back inside its range; `other` is what it is compared with. */
export function clampOperand(o: Operand, other?: Operand): Operand {
  const out = { ...o };
  if (out.n != null) { const [lo, hi] = nRange(o.ind); out.n = Math.round(clamp(out.n, lo, hi)); }
  if (out.m != null) { const [lo, hi, step] = mRange(o.ind); out.m = step >= 1 ? Math.round(clamp(out.m, lo, hi)) : Math.round(clamp(out.m, lo, hi) * 10) / 10; }
  if (out.value != null) {
    const lv = other ? levelRange(other.ind) : null;
    out.value = lv ? clamp(out.value, lv[0], lv[1]) : clamp(out.value, -1_000_000, 1_000_000);
  }
  return out;
}

/** Every condition's numbers inside their ranges, e.g. for rules loaded from a save or an AI draft. */
export function sanitizeRules(r: Rules): Rules {
  const lanes = ["long_entry", "long_exit", "short_entry", "short_exit"] as const;
  const next = { ...r };
  for (const l of lanes) next[l] = r[l].map((c) => ({ ...c, left: clampOperand(c.left, c.right), right: clampOperand(c.right, c.left) }));
  return next;
}
