"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { ApiError, type Fit } from "@/lib/api";

const TONE = {
  fits: "border-up/50 bg-up/10",
  close: "border-gold/50 bg-gold/10",
  over: "border-down/50 bg-down/10",
};
const DOT = { fits: "bg-up", close: "bg-gold", over: "bg-down" };

const show = (v: number | null, unit: string) => (v == null ? "–" : unit === "x" ? `${v.toFixed(1)}x` : `${v.toFixed(1)}%`);

/** Compares a backtest or the trade log with the limits of the user's risk profile. */
export default function FitPanel({ load, deps }: { load: () => Promise<Fit>; deps: unknown[] }) {
  const [fit, setFit] = useState<Fit | null>(null);
  const [state, setState] = useState<"loading" | "ok" | "no-profile" | "error">("loading");

  useEffect(() => {
    let live = true;
    setState("loading");
    load()
      .then((f) => live && (setFit(f), setState("ok")))
      .catch((e) => live && setState(e instanceof ApiError && e.status === 404 ? "no-profile" : "error"));
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);

  if (state === "no-profile")
    return (
      <p className="rounded-lg border border-border bg-surface p-3 text-sm text-muted">
        <Link href="/risk" className="text-gold">Take the 2-minute risk quiz</Link> to see whether these results fit
        your own risk limits.
      </p>
    );
  if (state !== "ok" || !fit || !fit.trades_checked) return null;

  return (
    <div className={`rounded-lg border p-4 ${TONE[fit.verdict]}`}>
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h3 className="font-medium">{fit.verdict_label}</h3>
        <span className="text-xs text-muted">
          Checked against your <Link href="/risk" className="underline">{fit.profile_label.toLowerCase()}</Link> limits
        </span>
      </div>
      <ul className="mt-3 grid gap-2 text-sm sm:grid-cols-3">
        {fit.checks.map((c) => (
          <li key={c.key} className="flex items-start gap-2">
            <span className={`mt-1.5 h-2 w-2 shrink-0 rounded-full ${DOT[c.level]}`} />
            <span>
              <span className="text-muted">{c.label}</span>
              <br />
              <span className="tabular-nums">{show(c.value, c.unit)}</span>
              <span className="text-muted"> (your limit {show(c.limit, c.unit)})</span>
            </span>
          </li>
        ))}
      </ul>
      {fit.notes.map((n) => (
        <p key={n} className="mt-2 text-sm text-muted">{n}</p>
      ))}
      {fit.suggested_units != null && (
        <p className="mt-2 text-sm">
          At about <strong>{fit.suggested_units} oz</strong> per trade instead of {fit.units} oz, these results would
          have stayed inside your limits.
        </p>
      )}
      <p className="mt-2 text-xs text-muted">Based on past results only. This is not a recommendation to trade.</p>
    </div>
  );
}
