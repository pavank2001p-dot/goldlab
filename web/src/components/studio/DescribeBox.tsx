"use client";

import { useEffect, useState } from "react";
import { api, type Rules } from "@/lib/api";
import { toast } from "../Toaster";
import { Icon } from "../ui";

const EXAMPLES = [
  "Buy when RSI drops below 30 and price is above the 200-day average; sell when RSI gets back over 60",
  "Go long when the 20 EMA crosses above the 50 EMA, short when it crosses below",
  "Buy a breakout above the 55-bar high while ADX is over 25, exit below the 20-bar low",
  "Fade the Bollinger bands: buy below the lower band, sell above the upper band",
];

/** Type an idea in plain words; the AI turns it into rules the studio can test straight away. */
export default function DescribeBox({ onRules }: { onRules: (r: Rules, note: string) => void }) {
  const [on, setOn] = useState<boolean | null>(null);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    api.assistantStatus().then((s) => setOn(s.configured), () => setOn(false));
  }, []);
  if (!on) return null;

  async function go(t = text) {
    if (t.trim().length < 8) return;
    setBusy(true);
    setErr(null);
    try {
      const r = await api.customDraft(t.trim());
      onRules(r.rules, r.explanation);
      toast(`Drafted: ${r.rules.name}`, { tone: "badge", body: r.possible ? "Check the rules below, then watch it trade." : "Some of that can't be expressed here, so this is the closest version." });
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Couldn't draft that");
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="card relative overflow-hidden p-5 sm:p-6">
      <div aria-hidden className="shimmer pointer-events-none absolute inset-0 opacity-40" />
      <div className="relative">
        <div className="flex items-center gap-2">
          <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-gradient-to-br from-gold-hi to-gold-deep text-black">
            <Icon name="assistant" className="h-4 w-4" />
          </span>
          <h2 className="font-semibold">Describe it in your own words</h2>
          <span className="ml-auto rounded-full border border-gold/30 px-2 py-0.5 text-[10px] font-medium uppercase tracking-wider text-gold">AI</span>
        </div>
        <form onSubmit={(e) => { e.preventDefault(); go(); }} className="mt-4 flex flex-col gap-2 sm:flex-row">
          <textarea value={text} onChange={(e) => setText(e.target.value)} rows={2} maxLength={600}
            onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); go(); } }}
            placeholder="e.g. Buy when gold pulls back to its 50-day average in an uptrend, and get out if RSI goes above 70"
            className="min-h-[3.25rem] flex-1 resize-none rounded-2xl border border-border bg-background/70 px-4 py-3 text-sm outline-none transition focus:border-gold" />
          <button type="submit" disabled={busy || text.trim().length < 8}
            className="flex items-center justify-center gap-2 rounded-2xl bg-gradient-to-b from-gold-hi to-gold px-5 py-3 text-sm font-semibold text-black transition-[filter] hover:brightness-105 disabled:opacity-50">
            {busy ? <><span className="h-4 w-4 animate-spin rounded-full border-2 border-black/30 border-t-black" />Drafting…</> : <>Draft my rules <Icon name="arrow" className="h-4 w-4" /></>}
          </button>
        </form>
        {err && <p className="mt-2 text-sm text-down">{err}</p>}
        <div className="mt-3 flex flex-wrap gap-1.5">
          <span className="py-1 text-xs text-muted">Try:</span>
          {EXAMPLES.map((x) => (
            <button key={x} type="button" disabled={busy} onClick={() => { setText(x); go(x); }}
              className="max-w-full truncate rounded-full border border-border bg-background/50 px-3 py-1 text-xs text-muted transition-colors hover:border-gold/50 hover:text-foreground">
              {x.length > 58 ? x.slice(0, 56) + "…" : x}
            </button>
          ))}
        </div>
      </div>
    </section>
  );
}
