"use client";

import { useEffect, useState } from "react";
import { Icon } from "./ui";

export type ToastTone = "up" | "down" | "info" | "fill" | "badge";
type Toast = { id: number; title: string; body?: string; tone: ToastTone };

const EVENT = "goldlab-toast";
let next = 1;

/** Show a message in the corner from anywhere. "fill" and "badge" get the celebratory treatment. */
export function toast(title: string, opts: { body?: string; tone?: ToastTone } = {}) {
  window.dispatchEvent(new CustomEvent<Toast>(EVENT, { detail: { id: next++, title, body: opts.body, tone: opts.tone ?? "info" } }));
}

const SPARKS = Array.from({ length: 10 }, (_, i) => {
  const a = (i / 10) * Math.PI * 2;
  return { dx: `${Math.cos(a) * 34}px`, dy: `${Math.sin(a) * 34}px`, delay: `${0.2 + (i % 3) * 0.04}s` };
});

function Mark({ tone }: { tone: ToastTone }) {
  if (tone === "fill" || tone === "badge") {
    const c = tone === "fill" ? "var(--up)" : "var(--gold)";
    return (
      <span className="relative flex h-10 w-10 shrink-0 items-center justify-center">
        {SPARKS.map((s, i) => (
          <span key={i} aria-hidden className="spark absolute h-1.5 w-1.5 rounded-full"
            style={{ background: i % 2 ? "var(--gold)" : c, ["--dx" as string]: s.dx, ["--dy" as string]: s.dy, animationDelay: s.delay }} />
        ))}
        <svg viewBox="0 0 40 40" className="badge-pop h-10 w-10" aria-hidden>
          <circle cx="20" cy="20" r="18" fill={`color-mix(in srgb, ${c} 18%, transparent)`} stroke={c} strokeWidth="2" />
          {tone === "fill"
            ? <path className="check-draw" pathLength={30} d="M12 20.5l5.5 5.5L28.5 15" fill="none" stroke={c} strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" />
            : <path className="check-draw" pathLength={30} d="M20 11l2.6 5.6 6.1.7-4.5 4.2 1.2 6-5.4-3-5.4 3 1.2-6-4.5-4.2 6.1-.7z" fill="none" stroke={c} strokeWidth="2" strokeLinejoin="round" />}
        </svg>
      </span>
    );
  }
  const c = tone === "up" ? "text-up bg-up/15" : tone === "down" ? "text-down bg-down/15" : "text-gold bg-gold/15";
  return (
    <span className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-full ${c}`}>
      <Icon name={tone === "up" ? "check" : tone === "down" ? "drop" : "bolt"} className="h-4 w-4" />
    </span>
  );
}

export default function Toaster() {
  const [items, setItems] = useState<Toast[]>([]);
  useEffect(() => {
    const on = (e: Event) => {
      const t = (e as CustomEvent<Toast>).detail;
      setItems((xs) => [...xs.slice(-2), t]);
      setTimeout(() => setItems((xs) => xs.filter((x) => x.id !== t.id)), t.tone === "fill" || t.tone === "badge" ? 6000 : 4500);
    };
    window.addEventListener(EVENT, on);
    return () => window.removeEventListener(EVENT, on);
  }, []);
  return (
    <div aria-live="polite" className="pointer-events-none fixed inset-x-4 bottom-4 z-[60] flex flex-col items-end gap-2 sm:left-auto sm:right-6 sm:w-96">
      {items.map((t) => (
        <div key={t.id} role="status"
          className={`toast-in pointer-events-auto flex w-full items-center gap-3 rounded-2xl border bg-surface/95 p-3 pr-4 shadow-2xl backdrop-blur ${
            t.tone === "fill" ? "border-up/40" : t.tone === "badge" ? "border-gold/50" : t.tone === "down" ? "border-down/40" : "border-border"}`}>
          <Mark tone={t.tone} />
          <div className="min-w-0 flex-1">
            <p className="text-sm font-semibold">{t.title}</p>
            {t.body && <p className="text-xs text-muted">{t.body}</p>}
          </div>
          <button type="button" aria-label="Dismiss" onClick={() => setItems((xs) => xs.filter((x) => x.id !== t.id))}
            className="text-muted transition-colors hover:text-foreground">
            <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden><path d="M6 6l12 12M18 6 6 18" /></svg>
          </button>
        </div>
      ))}
    </div>
  );
}
