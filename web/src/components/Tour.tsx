"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useCallback, useEffect, useLayoutEffect, useState } from "react";
import { useUser } from "@/lib/useUser";

const DONE = "goldlab-tour";
const EVENT = "goldlab-tour-start";

type Step = { target?: string; title: string; body: string };

const GUEST: Step[] = [
  { title: "Welcome to GoldLab", body: "A calm place to learn gold trading with real prices and no real money. This takes about 30 seconds." },
  { target: "menus", title: "Four menus, four steps", body: "Market shows what gold is doing. Test ideas checks strategies on the past. Practise lets you trade with virtual money. You holds your limits and the assistant." },
  { target: "chart", title: "Live price, deep history", body: "The chart follows the live price and goes back to 1833. Pick any timeframe, from seconds to months." },
  { target: "theme", title: "Make it yours", body: "Switch between dark and light, or pick an accent colour: gold, rose gold, platinum or sapphire." },
  { title: "Start with your limits", body: "A short quiz sets how much you are comfortable losing. Every other page checks against it, so decisions feel considered, not rushed." },
];

const MEMBER: Step[] = [
  { title: "Your desk", body: "This is your home now: the live price, your practice account, your agent, upcoming events and your habits, all at a glance." },
  { target: "paper", title: "Your practice account", body: "Equity and open profit or loss update every few seconds. A satisfying tick confirms every fill." },
  { target: "habits", title: "Habits, not wins", body: "Badges reward using a stop, staying inside your limit and keeping a journal. Never whether a trade made money." },
  { target: "theme", title: "Make it yours", body: "Switch between dark and light, or pick an accent colour." },
];

/** Starts the tour again from anywhere, such as a "Take the tour" link. */
export function startTour() {
  window.dispatchEvent(new Event(EVENT));
}

export function TourLink({ className = "" }: { className?: string }) {
  return <button type="button" onClick={startTour} className={className}>Take the tour</button>;
}

function visible(el: Element | null): el is HTMLElement {
  if (!el) return false;
  const r = el.getBoundingClientRect();
  return r.width > 0 && r.height > 0;
}

export default function Tour() {
  const path = usePathname();
  const { user } = useUser();
  const [i, setI] = useState<number | null>(null);
  const [rect, setRect] = useState<DOMRect | null>(null);
  const steps = user ? MEMBER : GUEST;
  const step = i == null ? null : steps[i];

  const finish = useCallback(() => {
    setI(null);
    try { localStorage.setItem(DONE, "1"); } catch {}
  }, []);

  // First visit to the home page: start once we know whether they are signed in.
  useEffect(() => {
    if (path !== "/" || user === undefined) return;
    let seen = true;
    try { seen = !!localStorage.getItem(DONE); } catch {}
    if (seen) return;
    const t = setTimeout(() => setI(0), 1200);
    return () => clearTimeout(t);
  }, [path, user]);

  useEffect(() => {
    const on = () => {
      if (path !== "/") window.location.href = "/";
      setI(0);
    };
    window.addEventListener(EVENT, on);
    return () => window.removeEventListener(EVENT, on);
  }, [path]);

  // Follow the highlighted element as the page scrolls or resizes.
  useLayoutEffect(() => {
    if (!step) return;
    // The same target can exist twice (desktop menus and the phone menu button); use the one on screen.
    const el = step.target ? Array.from(document.querySelectorAll(`[data-tour="${step.target}"]`)).find(visible) ?? null : null;
    if (!visible(el)) {
      setRect(null);
      return;
    }
    const measure = () => setRect(el.getBoundingClientRect());
    const r = el.getBoundingClientRect();
    if (r.top < 70 || r.bottom > window.innerHeight - 220) el.scrollIntoView({ block: "center", behavior: "smooth" });
    measure();
    const t = setInterval(measure, 120); // covers smooth scrolling and late layout
    const stop = setTimeout(() => clearInterval(t), 1200);
    window.addEventListener("resize", measure);
    window.addEventListener("scroll", measure, { passive: true });
    return () => {
      clearInterval(t);
      clearTimeout(stop);
      window.removeEventListener("resize", measure);
      window.removeEventListener("scroll", measure);
    };
  }, [step]);

  useEffect(() => {
    if (i == null) return;
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape") finish();
      if (e.key === "ArrowRight") setI((x) => (x == null ? x : Math.min(x + 1, steps.length - 1)));
      if (e.key === "ArrowLeft") setI((x) => (x == null ? x : Math.max(x - 1, 0)));
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, [i, finish, steps.length]);

  if (i == null || !step) return null;
  const last = i === steps.length - 1;
  const pad = 8;
  // Place the card below the highlight when there's room, otherwise above it; centred when there's no target.
  const below = rect ? rect.bottom + 220 < window.innerHeight : true;
  const narrow = typeof window !== "undefined" && window.innerWidth < 640;
  const cardStyle: React.CSSProperties = !rect || narrow
    ? {}
    : {
        top: below ? rect.bottom + pad + 14 : undefined,
        bottom: below ? undefined : window.innerHeight - rect.top + pad + 14,
        left: Math.min(Math.max(rect.left + rect.width / 2 - 180, 16), window.innerWidth - 376),
      };

  return (
    <div className="fixed inset-0 z-[70]" role="dialog" aria-modal="true" aria-labelledby="tour-title">
      {rect ? (
        <div aria-hidden className="tour-hole pointer-events-none fixed rounded-2xl"
          style={{ top: rect.top - pad, left: rect.left - pad, width: rect.width + pad * 2, height: rect.height + pad * 2 }} />
      ) : <div aria-hidden className="fan-in fixed inset-0 bg-[rgb(5_7_10/0.72)] backdrop-blur-[2px]" />}
      <div key={i} style={cardStyle}
        className={`rise-in fixed max-w-[22.5rem] rounded-2xl border border-gold/40 bg-surface p-5 shadow-2xl ${
          !rect ? "left-1/2 top-1/2 w-[calc(100%-2rem)] -translate-x-1/2 -translate-y-1/2" : narrow ? "inset-x-4 bottom-4 max-w-none" : "w-[22.5rem]"}`}>
        <div className="flex items-center gap-1.5" aria-hidden>
          {steps.map((_, k) => (
            <span key={k} className={`h-1 rounded-full transition-all duration-300 ${k === i ? "w-6 bg-gold" : k < i ? "w-2 bg-gold/50" : "w-2 bg-border"}`} />
          ))}
          <span className="ml-auto text-[11px] tabular-nums text-muted">{i + 1} / {steps.length}</span>
        </div>
        <h2 id="tour-title" className="mt-3 text-lg font-semibold">{step.title}</h2>
        <p className="mt-1.5 text-sm leading-relaxed text-muted">{step.body}</p>
        <div className="mt-5 flex items-center gap-2">
          <button type="button" onClick={finish} className="text-sm text-muted transition-colors hover:text-foreground">
            {last ? "Close" : "Skip"}
          </button>
          <div className="ml-auto flex gap-2">
            {i > 0 && (
              <button type="button" onClick={() => setI(i - 1)} className="rounded-full border border-border px-4 py-1.5 text-sm transition-colors hover:border-muted">Back</button>
            )}
            {last && !user ? (
              <Link href="/risk" onClick={finish}
                className="rounded-full bg-gradient-to-b from-gold-hi to-gold px-4 py-1.5 text-sm font-semibold text-black">Take the quiz</Link>
            ) : (
              <button type="button" autoFocus onClick={() => (last ? finish() : setI(i + 1))}
                className="rounded-full bg-gradient-to-b from-gold-hi to-gold px-4 py-1.5 text-sm font-semibold text-black">
                {last ? "Done" : i === 0 ? "Show me" : "Next"}
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
