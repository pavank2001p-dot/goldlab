"use client";

import { useCallback, useEffect, useState } from "react";
import ReportView from "@/components/ReportView";
import SignInPrompt from "@/components/SignInPrompt";
import { api, fmtUsd, type ImportResult, type Report, type Trade, type TradeInput } from "@/lib/api";
import { useUser } from "@/lib/useUser";

const input = "w-full rounded-md border border-border bg-background px-3 py-1.5 outline-none focus:border-gold";

const blank = { side: "long", units: "", open_time: "", open_price: "", close_time: "", close_price: "", stop_loss: "", take_profit: "", fees: "", swap: "", notes: "" };

const num = (v: string) => (v.trim() === "" ? null : Number(v));
const utc = (v: string) => (v ? `${v}:00Z` : null); // datetime-local value, entered as UTC

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block text-sm">
      <span className="text-muted">{label}</span>
      <div className="mt-1">{children}</div>
    </label>
  );
}

export default function TradesPage() {
  const { user } = useUser();
  const [trades, setTrades] = useState<Trade[]>([]);
  const [report, setReport] = useState<Report | null>(null);
  const [capital, setCapital] = useState(10000);
  const [f, setF] = useState(blank);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [contract, setContract] = useState(100);
  const [imported, setImported] = useState<ImportResult | null>(null);

  const refresh = useCallback(async () => {
    const [t, r] = await Promise.all([api.trades(), api.tradeReport(capital)]);
    setTrades(t);
    setReport(r);
  }, [capital]);

  useEffect(() => {
    if (user) refresh().catch(() => {});
  }, [user, refresh]);

  if (user === null) return <SignInPrompt what="keep a log of your gold trades" next="/trades" />;
  if (user === undefined) return null;

  const set = (k: keyof typeof blank) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) =>
    setF({ ...f, [k]: e.target.value });

  async function add(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const t: TradeInput = {
        side: f.side as "long" | "short",
        units: Number(f.units),
        open_time: utc(f.open_time)!,
        open_price: Number(f.open_price),
        close_time: utc(f.close_time),
        close_price: num(f.close_price),
        stop_loss: num(f.stop_loss),
        take_profit: num(f.take_profit),
        fees: num(f.fees) ?? 0,
        swap: num(f.swap) ?? 0,
        notes: f.notes,
      };
      await api.addTrade(t);
      setF(blank);
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't save the trade");
    } finally {
      setBusy(false);
    }
  }

  async function upload(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    setError(null);
    try {
      setImported(await api.importTrades(file, contract));
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Import failed");
    }
  }

  async function remove(id: number) {
    await api.deleteTrade(id);
    await refresh();
  }

  return (
    <div className="mx-auto max-w-6xl space-y-8 px-4 py-8">
      <div>
        <h1 className="text-xl font-semibold">Your trade log</h1>
        <p className="mt-1 text-sm text-muted">
          Log your gold trades by hand or import your broker&apos;s history, and get the same report as a backtest.
        </p>
      </div>

      <div className="grid gap-6 lg:grid-cols-[1fr_320px]">
        <form onSubmit={add} className="rounded-lg border border-border p-4">
          <h2 className="font-medium">Add a trade</h2>
          <div className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-4">
            <Field label="Side">
              <select className={input} value={f.side} onChange={set("side")}>
                <option value="long">Long (buy)</option>
                <option value="short">Short (sell)</option>
              </select>
            </Field>
            <Field label="Ounces (1 lot = 100)"><input required type="number" step="any" min="0.01" className={input} value={f.units} onChange={set("units")} /></Field>
            <Field label="Opened (UTC)"><input required type="datetime-local" className={input} value={f.open_time} onChange={set("open_time")} /></Field>
            <Field label="Open price"><input required type="number" step="any" min="0" className={input} value={f.open_price} onChange={set("open_price")} /></Field>
            <Field label="Stop loss"><input type="number" step="any" className={input} value={f.stop_loss} onChange={set("stop_loss")} /></Field>
            <Field label="Take profit"><input type="number" step="any" className={input} value={f.take_profit} onChange={set("take_profit")} /></Field>
            <Field label="Closed (UTC)"><input type="datetime-local" className={input} value={f.close_time} onChange={set("close_time")} /></Field>
            <Field label="Close price"><input type="number" step="any" min="0" className={input} value={f.close_price} onChange={set("close_price")} /></Field>
            <Field label="Commission ($)"><input type="number" step="any" min="0" className={input} value={f.fees} onChange={set("fees")} /></Field>
            <Field label="Swap ($, + or -)"><input type="number" step="any" className={input} value={f.swap} onChange={set("swap")} /></Field>
            <div className="col-span-2"><Field label="Notes"><input maxLength={1000} className={input} value={f.notes} onChange={set("notes")} /></Field></div>
          </div>
          <div className="mt-3 flex items-center gap-3">
            <button disabled={busy} className="rounded-md bg-gold px-4 py-1.5 font-medium text-black disabled:opacity-60">Save trade</button>
            <span className="text-xs text-muted">Leave the close fields empty for a trade that&apos;s still open.</span>
          </div>
        </form>

        <div className="rounded-lg border border-border p-4">
          <h2 className="font-medium">Import from your broker</h2>
          <p className="mt-1 text-xs text-muted">
            Upload a CSV of your trade history. MetaTrader 4/5 and most broker exports work. Only gold (XAU) rows are
            imported, and re-importing the same file skips trades you already have.
          </p>
          <div className="mt-3 space-y-3">
            <Field label="Ounces per lot at your broker">
              <input type="number" min="1" className={input} value={contract} onChange={(e) => setContract(Number(e.target.value) || 100)} />
            </Field>
            <label className="block cursor-pointer rounded-md border border-dashed border-border px-3 py-3 text-center text-sm hover:border-gold">
              Choose CSV file
              <input type="file" accept=".csv,.txt,text/csv" className="hidden" onChange={upload} />
            </label>
            <a href="/trade-log-template.csv" className="block text-xs text-gold">Download a template</a>
            {imported && (
              <div className="text-xs">
                <p>Imported {imported.imported} {imported.imported === 1 ? "trade" : "trades"}{imported.duplicates ? `, ${imported.duplicates} already in your log` : ""}.</p>
                {imported.skipped_count > 0 && (
                  <details className="mt-1 text-muted">
                    <summary>{imported.skipped_count} {imported.skipped_count === 1 ? "row" : "rows"} skipped</summary>
                    <ul className="mt-1 list-disc pl-4">{imported.skipped.map((s) => <li key={s}>{s}</li>)}</ul>
                  </details>
                )}
              </div>
            )}
          </div>
        </div>
      </div>
      {error && <p className="text-sm text-down">{error}</p>}

      <section>
        <div className="mb-3 flex flex-wrap items-center gap-3">
          <h2 className="font-medium">Report</h2>
          <label className="ml-auto flex items-center gap-2 text-sm text-muted">
            Starting balance ($)
            <input type="number" min="1" className={`${input} w-32`} value={capital} onChange={(e) => setCapital(Number(e.target.value) || 10000)} />
          </label>
        </div>
        {report && <ReportView report={report} kind="log" />}
      </section>

      {trades.length > 0 && (
        <section>
          <h2 className="mb-2 font-medium">All trades ({trades.length})</h2>
          <div className="overflow-x-auto rounded-lg border border-border">
            <table className="w-full text-sm tabular-nums">
              <thead className="bg-surface text-left text-xs text-muted">
                <tr>
                  <th className="px-3 py-2">Side</th>
                  <th className="px-3 py-2">Opened (UTC)</th>
                  <th className="px-3 py-2 text-right">Open</th>
                  <th className="px-3 py-2 text-right">Close</th>
                  <th className="px-3 py-2 text-right">Oz</th>
                  <th className="px-3 py-2 text-right">P&amp;L</th>
                  <th className="px-3 py-2">Notes</th>
                  <th className="px-3 py-2" />
                </tr>
              </thead>
              <tbody>
                {trades.map((t) => (
                  <tr key={t.id} className="border-t border-border">
                    <td className={`px-3 py-1.5 ${t.side === "long" ? "text-up" : "text-down"}`}>{t.side}</td>
                    <td className="whitespace-nowrap px-3 py-1.5">{t.open_time.slice(0, 16).replace("T", " ")}</td>
                    <td className="px-3 py-1.5 text-right">{t.open_price.toFixed(2)}</td>
                    <td className="px-3 py-1.5 text-right">{t.close_price?.toFixed(2) ?? <span className="text-muted">open</span>}</td>
                    <td className="px-3 py-1.5 text-right">{t.units}</td>
                    <td className={`px-3 py-1.5 text-right ${(t.pnl ?? 0) >= 0 ? "text-up" : "text-down"}`}>{fmtUsd(t.pnl)}</td>
                    <td className="max-w-48 truncate px-3 py-1.5 text-muted">{t.notes}</td>
                    <td className="px-3 py-1.5 text-right">
                      <button onClick={() => remove(t.id)} className="text-xs text-muted hover:text-down">Delete</button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}
    </div>
  );
}
