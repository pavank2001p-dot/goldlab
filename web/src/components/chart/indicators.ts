import type { Bar } from "@/lib/api";

export type Pt = { time: number; value: number };

export function sma(xs: number[], n: number): (number | null)[] {
  const out: (number | null)[] = [];
  let sum = 0;
  xs.forEach((x, i) => {
    sum += x;
    if (i >= n) sum -= xs[i - n];
    out.push(i >= n - 1 ? sum / n : null);
  });
  return out;
}

export function ema(xs: number[], n: number): (number | null)[] {
  const k = 2 / (n + 1), out: (number | null)[] = [];
  let e: number | null = null;
  xs.forEach((x, i) => {
    if (i < n - 1) return out.push(null);
    e = e == null ? xs.slice(0, n).reduce((a, b) => a + b, 0) / n : x * k + e * (1 - k);
    out.push(e);
  });
  return out;
}

export function stdev(xs: number[], n: number): (number | null)[] {
  return xs.map((_, i) => {
    if (i < n - 1) return null;
    const w = xs.slice(i - n + 1, i + 1), m = w.reduce((a, b) => a + b, 0) / n;
    return Math.sqrt(w.reduce((a, b) => a + (b - m) ** 2, 0) / n);
  });
}

export function rsi(xs: number[], n = 14): (number | null)[] {
  const out: (number | null)[] = [null];
  let up = 0, dn = 0;
  for (let i = 1; i < xs.length; i++) {
    const d = xs[i] - xs[i - 1], g = Math.max(d, 0), l = Math.max(-d, 0);
    if (i <= n) {
      up += g / n;
      dn += l / n;
      out.push(i === n ? (dn === 0 ? 100 : 100 - 100 / (1 + up / dn)) : null);
    } else {
      up = (up * (n - 1) + g) / n;
      dn = (dn * (n - 1) + l) / n;
      out.push(dn === 0 ? 100 : 100 - 100 / (1 + up / dn));
    }
  }
  return out;
}

export function macd(xs: number[], f = 12, s = 26, sig = 9) {
  const a = ema(xs, f), b = ema(xs, s);
  const line = xs.map((_, i) => (a[i] != null && b[i] != null ? a[i]! - b[i]! : null));
  const first = line.findIndex((v) => v != null);
  const sigRaw = first < 0 ? [] : ema(line.slice(first) as number[], sig);
  const signal = line.map((_, i) => (i < first ? null : sigRaw[i - first] ?? null));
  return { line, signal, hist: line.map((v, i) => (v != null && signal[i] != null ? v - signal[i]! : null)) };
}

export const pts = (bars: Bar[], vs: (number | null)[]): Pt[] =>
  vs.flatMap((v, i) => (v == null || !isFinite(v) ? [] : [{ time: bars[i].t, value: v }]));

export type IndKey = "sma20" | "sma50" | "sma200" | "ema21" | "bb" | "rsi" | "macd";
export const IND_LIST: { key: IndKey; label: string; pane: boolean; color: string }[] = [
  { key: "sma20", label: "Moving average 20", pane: false, color: "#7fb0e6" },
  { key: "sma50", label: "Moving average 50", pane: false, color: "#e8b53e" },
  { key: "sma200", label: "Moving average 200", pane: false, color: "#c084fc" },
  { key: "ema21", label: "Exponential average 21", pane: false, color: "#f472b6" },
  { key: "bb", label: "Bollinger bands (20, 2)", pane: false, color: "#94a3b8" },
  { key: "rsi", label: "RSI (14)", pane: true, color: "#e8b53e" },
  { key: "macd", label: "MACD (12, 26, 9)", pane: true, color: "#7fb0e6" },
];
