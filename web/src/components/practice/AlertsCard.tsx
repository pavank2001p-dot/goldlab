"use client";

import { useCallback, useEffect, useState } from "react";
import { useUser } from "@/lib/useUser";
import { api, fmtPrice, type PriceAlert } from "@/lib/api";
import { Icon } from "../ui";
import { ALERTS_EVENT } from "./AlertWatcher";

/** Set, see and remove price alerts. They are checked while the site is open in any tab. */
export default function AlertsCard({ price: given = null, open: startOpen = false }: { price?: number | null; open?: boolean }) {
  const [latest, setLatest] = useState<number | null>(null);
  const price = given ?? latest;
  const [alerts, setAlerts] = useState<PriceAlert[] | null>(null);
  const [level, setLevel] = useState("");
  const [note, setNote] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [perm, setPerm] = useState<NotificationPermission | "unsupported">("default");

  const load = useCallback(() => { api.alerts().then(setAlerts, () => setAlerts([])); }, []);
  useEffect(() => {
    load();
    if (given == null) api.candles("1m", { limit: 1 }).then((b) => b.length && setLatest(b[b.length - 1].c), () => {});
    setPerm("Notification" in window ? Notification.permission : "unsupported");
    window.addEventListener(ALERTS_EVENT, load);
    return () => window.removeEventListener(ALERTS_EVENT, load);
  }, [load, given]);

  async function add(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    const p = Number(level);
    if (!(p > 0)) return setError("Enter a price.");
    try {
      await api.addAlert(p, note);
      setLevel(""); setNote("");
      load();
    } catch (x) { setError(x instanceof Error ? x.message : "Couldn't add that alert"); }
  }

  const waiting = (alerts ?? []).filter((a) => !a.triggered_at);
  const recent = (alerts ?? []).filter((a) => a.triggered_at).slice(0, 3);
  const nudge = (d: number, pct = false) => price && setLevel((pct ? price * (1 + d / 100) : price + d).toFixed(2));

  return (
    <details className="card group p-4" open={startOpen}>
      <summary className="flex cursor-pointer list-none items-center gap-2 font-medium">
        <svg viewBox="0 0 24 24" className="h-4 w-4 text-gold" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden><path d="M6 16V11a6 6 0 1 1 12 0v5l2 2H4l2-2ZM10 21h4" /></svg>
        Price alerts
        {waiting.length > 0 && <span className="rounded-full bg-gold/15 px-1.5 text-xs tabular-nums text-gold">{waiting.length}</span>}
        <Icon name="down" className="ml-auto h-4 w-4 text-muted transition-transform group-open:rotate-180" />
      </summary>
      <form onSubmit={add} className="mt-3 space-y-2">
        <div className="flex gap-2">
          <input inputMode="decimal" value={level} onChange={(e) => setLevel(e.target.value)} placeholder={price ? `e.g. ${(price + 25).toFixed(0)}` : "Price"} aria-label="Alert price"
            className="w-full rounded-lg border border-border bg-background px-2.5 py-1.5 text-sm tabular-nums outline-none focus:border-gold" />
          <button className="shrink-0 rounded-full bg-gradient-to-b from-gold-hi to-gold px-4 text-sm font-semibold text-black">Add</button>
        </div>
        {price && (
          <div className="flex flex-wrap gap-1.5 text-[11px]">
            {([[-1, true], [-10, false], [10, false], [1, true]] as const).map(([d, pct]) => (
              <button key={`${d}${pct}`} type="button" onClick={() => nudge(d, pct)} className="rounded-full border border-border px-2 py-0.5 text-muted hover:border-gold/40 hover:text-foreground">
                {d > 0 ? "+" : "−"}{pct ? `${Math.abs(d)}%` : `$${Math.abs(d)}`}
              </button>
            ))}
          </div>
        )}
        <input value={note} onChange={(e) => setNote(e.target.value)} maxLength={120} placeholder="Note to self (optional)" aria-label="Note"
          className="w-full rounded-lg border border-border bg-background px-2.5 py-1.5 text-sm outline-none focus:border-gold" />
        {error && <p role="alert" className="text-xs text-down">{error}</p>}
      </form>
      {alerts && (
        <ul className="mt-3 space-y-1.5 text-sm">
          {waiting.map((a) => (
            <li key={a.id} className="flex items-center gap-2 rounded-lg bg-background/50 px-2.5 py-1.5">
              <Icon name={a.direction === "above" ? "up" : "down"} className={`h-3.5 w-3.5 ${a.direction === "above" ? "text-up" : "text-down"}`} />
              <span className="tabular-nums">{fmtPrice(a.price)}</span>
              <span className="min-w-0 flex-1 truncate text-xs text-muted">{a.note}</span>
              <button type="button" onClick={() => api.deleteAlert(a.id).then(load)} aria-label={`Remove alert at ${fmtPrice(a.price)}`} className="text-muted hover:text-down">×</button>
            </li>
          ))}
          {recent.map((a) => (
            <li key={a.id} className="flex items-center gap-2 px-2.5 text-xs text-muted">
              <Icon name="check" className="h-3.5 w-3.5 text-gold" /> Reached {fmtPrice(a.price)}
              <button type="button" onClick={() => api.deleteAlert(a.id).then(load)} className="ml-auto hover:text-foreground">Clear</button>
            </li>
          ))}
          {!waiting.length && !recent.length && <li className="text-xs text-muted">No alerts yet. Add a level you want to hear about instead of watching the chart.</li>}
        </ul>
      )}
      <p className="mt-3 text-[11px] text-muted">
        Checked every 30 seconds while GoldLab is open in a tab, and caught up when you come back.
        {perm === "default" && <> <button type="button" onClick={() => Notification.requestPermission().then(setPerm)} className="text-gold underline">Also show browser notifications</button>.</>}
        {perm === "granted" && " Browser notifications are on."}
      </p>
    </details>
  );
}

/** The alerts card for signed-in visitors only, for pages anyone can open. */
export function SignedInAlerts(props: { open?: boolean }) {
  const { user } = useUser();
  return user ? <AlertsCard {...props} /> : null;
}
