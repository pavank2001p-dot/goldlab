"use client";

import { useEffect, useRef, useState } from "react";

/** Line icons drawn on a 24px grid. */
const PATHS: Record<string, React.ReactNode> = {
  chart: <path d="M4 19h16M7 15V9m0 0V7m0 2h0M12 16V6m5 7v-3" />,
  candles: <><path d="M7 4v16M17 4v16" /><rect x="5" y="8" width="4" height="7" rx="1" /><rect x="15" y="6" width="4" height="9" rx="1" /></>,
  backtest: <path d="M3 3v18h18M7 15l4-5 3 3 5-7" />,
  scenarios: <><path d="M3 12h4" /><path d="M7 12c4 0 6-6 14-7M7 12c4 0 6 6 14 7M7 12h14" /></>,
  trades: <><rect x="4" y="3" width="16" height="18" rx="2" /><path d="M8 8h8M8 12h8M8 16h5" /></>,
  news: <><path d="M5 4h11v16H6a2 2 0 0 1-2-2V5a1 1 0 0 1 1-1Z" /><path d="M16 8h3a1 1 0 0 1 1 1v9a2 2 0 0 1-2 2M8 8h5M8 12h5M8 16h3" /></>,
  risk: <path d="M12 3 4 7v5c0 4.5 3.4 8.3 8 9 4.6-.7 8-4.5 8-9V7l-8-4Z" />,
  assistant: <><path d="M12 3l1.8 4.7L18.5 9.5l-4.7 1.8L12 16l-1.8-4.7L5.5 9.5l4.7-1.8L12 3Z" /><path d="M18 15l.8 2.2L21 18l-2.2.8L18 21l-.8-2.2L15 18l2.2-.8L18 15Z" /></>,
  account: <><circle cx="12" cy="8" r="4" /><path d="M4 21c1.5-4 4.5-6 8-6s6.5 2 8 6" /></>,
  up: <path d="M5 15l7-7 7 7" />,
  down: <path d="M5 9l7 7 7-7" />,
  arrow: <path d="M5 12h14m-6-6 6 6-6 6" />,
  calendar: <><rect x="4" y="5" width="16" height="15" rx="2" /><path d="M4 10h16M9 3v4M15 3v4" /></>,
  clock: <><circle cx="12" cy="12" r="8" /><path d="M12 8v4l3 2" /></>,
  search: <><circle cx="11" cy="11" r="6" /><path d="m20 20-4.5-4.5" /></>,
  upload: <path d="M12 16V4m0 0-4 4m4-4 4 4M4 16v3a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-3" />,
  trophy: <path d="M8 4h8v5a4 4 0 0 1-8 0V4Zm4 9v4m-4 3h8M8 6H5a3 3 0 0 0 3 4m8-4h3a3 3 0 0 1-3 4" />,
  wallet: <><rect x="3" y="6" width="18" height="13" rx="2" /><path d="M3 10h18M16 14h2" /></>,
  drop: <path d="M3 6l6 6 4-4 8 8m0 0v-5m0 5h-5" />,
  scale: <path d="M12 4v16M5 8h14M5 8l-3 6a3 3 0 0 0 6 0L5 8Zm14 0-3 6a3 3 0 0 0 6 0l-3-6Z" />,
  bolt: <path d="M13 3 5 14h6l-1 7 8-11h-6l1-7Z" />,
  percent: <><path d="M19 5 5 19" /><circle cx="7" cy="7" r="2" /><circle cx="17" cy="17" r="2" /></>,
  layers: <path d="m12 3 9 5-9 5-9-5 9-5Zm-9 9 9 5 9-5M3 16l9 5 9-5" />,
  check: <path d="m5 12 4 4 10-10" />,
};

export function Icon({ name, className = "h-4 w-4", strokeWidth = 1.8 }: { name: string; className?: string; strokeWidth?: number }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={strokeWidth} strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden>
      {PATHS[name]}
    </svg>
  );
}

/** Title block shared by every section page. */
export function PageHeader({ icon, title, subtitle, right }: { icon: string; title: string; subtitle?: React.ReactNode; right?: React.ReactNode }) {
  return (
    <div className="flex flex-wrap items-start gap-3">
      <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-2xl border border-gold/30 bg-gradient-to-br from-gold/25 to-gold/5 text-gold">
        <Icon name={icon} className="h-5 w-5" />
      </span>
      <div className="min-w-0 flex-1">
        <h1 className="text-xl font-semibold tracking-tight sm:text-2xl">{title}</h1>
        {subtitle && <p className="mt-0.5 text-sm text-muted">{subtitle}</p>}
      </div>
      {right}
    </div>
  );
}

/** Animates a number from 0 to its value when it first appears or changes. */
export function CountUp({ value, format, ms = 700 }: { value: number; format: (v: number) => string; ms?: number }) {
  const [shown, setShown] = useState(value);
  const from = useRef(0);
  useEffect(() => {
    if (typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) {
      setShown(value);
      return;
    }
    const start = performance.now(), a = from.current;
    let raf = 0;
    const tick = (now: number) => {
      const k = Math.min((now - start) / ms, 1);
      const e = 1 - Math.pow(1 - k, 3);
      setShown(a + (value - a) * e);
      if (k < 1) raf = requestAnimationFrame(tick);
      else from.current = value;
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [value, ms]);
  return <>{format(shown)}</>;
}

/** A row of filter chips with optional counts. */
export function Chips<T extends string>({ options, value, onChange }: {
  options: { key: T; label: string; count?: number; dot?: string }[];
  value: T;
  onChange: (v: T) => void;
}) {
  return (
    <div className="flex flex-wrap gap-1.5">
      {options.map((o) => (
        <button key={o.key} type="button" onClick={() => onChange(o.key)} aria-pressed={value === o.key}
          className={`flex items-center gap-1.5 rounded-full border px-3 py-1 text-xs transition-colors ${
            value === o.key ? "border-gold bg-gold/15 text-foreground" : "border-border text-muted hover:border-muted hover:text-foreground"
          }`}>
          {o.dot && <span className="h-1.5 w-1.5 rounded-full" style={{ background: o.dot }} />}
          {o.label}
          {o.count != null && <span className="tabular-nums opacity-60">{o.count}</span>}
        </button>
      ))}
    </div>
  );
}

/** Long / short label. */
export function SidePill({ side }: { side: "long" | "short" }) {
  return (
    <span className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium ${side === "long" ? "bg-up/15 text-up" : "bg-down/15 text-down"}`}>
      <Icon name={side === "long" ? "up" : "down"} className="h-3 w-3" strokeWidth={2.4} />
      {side === "long" ? "Long" : "Short"}
    </span>
  );
}

/** A friendly empty state. */
export function Empty({ icon, title, children }: { icon: string; title: string; children?: React.ReactNode }) {
  return (
    <div className="rounded-2xl border border-dashed border-border px-6 py-10 text-center">
      <span className="mx-auto flex h-12 w-12 items-center justify-center rounded-full bg-surface text-muted">
        <Icon name={icon} className="h-6 w-6" />
      </span>
      <p className="mt-3 font-medium">{title}</p>
      {children && <div className="mx-auto mt-1 max-w-md text-sm text-muted">{children}</div>}
    </div>
  );
}
