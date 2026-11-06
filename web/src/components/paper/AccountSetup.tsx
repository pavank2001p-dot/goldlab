"use client";

import { useState } from "react";
import { api, fmtUsd, type PaperState } from "@/lib/api";
import { Icon } from "../ui";
import LeveragePicker, { shortUsd } from "./LeveragePicker";

const PRESETS = [1_000, 5_000, 10_000, 50_000, 100_000, 1_000_000];
export const SETUP_KEY = "goldlab-paper-setup";

/** First visit to paper trading: choose how much virtual money to start with and the leverage, like opening a broker account. */
export default function AccountSetup({ state, onDone }: { state: PaperState; onDone: (msg: string | null) => void }) {
  const [bal, setBal] = useState(state.account.starting_balance);
  const [text, setText] = useState(String(state.account.starting_balance));
  const [lev, setLev] = useState(state.account.leverage);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const max = state.settings.max_balance;

  function remember() {
    try { localStorage.setItem(SETUP_KEY, "1"); } catch {}
  }

  async function open() {
    setBusy(true);
    setErr(null);
    try {
      await api.paperReset(bal, lev);
      remember();
      onDone(`Your practice account is open: ${fmtUsd(bal)} at 1:${lev}`);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Couldn't open the account");
    } finally {
      setBusy(false);
    }
  }

  const pickText = (v: string) => {
    setText(v);
    const n = Number(v.replace(/[,$\s]/g, ""));
    if (n >= 1 && n <= max) setBal(n);
  };

  return (
    <section className="rise-in relative mt-6 overflow-hidden rounded-3xl border border-gold/40 bg-gradient-to-br from-gold/12 via-surface to-surface p-5 sm:p-8">
      <div aria-hidden className="pointer-events-none absolute -right-20 -top-20 h-64 w-64 rounded-full bg-gold/20 blur-3xl" />
      <div className="relative">
        <p className="text-xs font-semibold uppercase tracking-widest text-gold">Step 1 of 1 · Open your practice account</p>
        <h2 className="mt-2 text-2xl font-bold tracking-tight sm:text-3xl">How much would you like to practise with?</h2>
        <p className="mt-1 max-w-2xl text-sm text-muted">It&apos;s virtual money on real gold prices. Pick an amount close to what you&apos;d really trade, so the habits carry over. You can change it any time in Account settings.</p>

        <div className="mt-6 grid gap-6 lg:grid-cols-2">
          <div>
            <label className="text-sm font-medium" htmlFor="setup-bal">Starting balance</label>
            <div className="mt-2 flex items-center rounded-2xl border border-border bg-background/70 px-4 focus-within:border-gold">
              <span className="text-2xl font-semibold text-muted">$</span>
              <input id="setup-bal" value={text} inputMode="decimal" onChange={(e) => pickText(e.target.value)}
                className="w-full bg-transparent px-2 py-3 text-3xl font-bold tabular-nums outline-none" />
            </div>
            <input type="range" min={0} max={PRESETS.length - 1} step={0.01} aria-label="Starting balance"
              value={Math.log10(bal / 1000) / Math.log10(1000) * (PRESETS.length - 1)}
              onChange={(e) => {
                const v = Math.round(1000 * Math.pow(1000, Number(e.target.value) / (PRESETS.length - 1)) / 100) * 100;
                setBal(v);
                setText(String(v));
              }}
              className="mt-4 w-full cursor-pointer accent-[var(--gold)]" />
            <div className="mt-2 flex flex-wrap gap-1.5">
              {PRESETS.map((v) => (
                <button key={v} type="button" onClick={() => { setBal(v); setText(String(v)); }}
                  className={`rounded-full border px-3 py-1 text-xs tabular-nums transition ${bal === v ? "border-gold bg-gold/15 text-foreground" : "border-border text-muted hover:text-foreground"}`}>
                  {shortUsd(v)}
                </button>
              ))}
            </div>
            <p className="mt-2 text-xs text-muted">Any amount from $1 up to {shortUsd(max)}.</p>
          </div>
          <div>
            <p className="text-sm font-medium">Leverage</p>
            <div className="mt-2">
              <LeveragePicker value={lev} onPick={setLev} balance={bal} price={state.price?.bid ?? 2000}
                stopOut={state.settings.stop_out_pct} marginCall={state.settings.margin_call_pct} />
            </div>
          </div>
        </div>

        {err && <p className="mt-4 text-sm text-down">{err}</p>}
        <div className="mt-6 flex flex-wrap items-center gap-3">
          <button type="button" onClick={open} disabled={busy}
            className="flex items-center gap-2 rounded-full bg-gradient-to-b from-gold-hi to-gold px-6 py-3 font-semibold text-black shadow-[0_10px_30px_-12px_var(--gold)] transition-[filter] hover:brightness-105 disabled:opacity-50">
            Open my account with {shortUsd(bal)} at 1:{lev} <Icon name="arrow" className="h-4 w-4" />
          </button>
          <button type="button" onClick={() => { remember(); onDone(null); }} className="text-sm text-muted hover:text-foreground">
            Keep {shortUsd(state.account.starting_balance)} at 1:{state.account.leverage}
          </button>
        </div>
      </div>
    </section>
  );
}
