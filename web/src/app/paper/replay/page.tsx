"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import ReplayPlayer from "@/components/practice/ReplayPlayer";
import ReplaySummary from "@/components/practice/ReplaySummary";
import { Chips, Icon, PageHeader } from "@/components/ui";
import { api, type Replay, type ReplaySettled, type ReplayTf } from "@/lib/api";
import { TF_LABEL } from "@/lib/replay";

const TFS: { key: ReplayTf; label: string }[] = [
  { key: "5m", label: "5 min · one day" },
  { key: "15m", label: "15 min · one day" },
  { key: "1h", label: "1 hour · one week" },
];

export default function ReplayPage() {
  const [tf, setTf] = useState<ReplayTf>("5m");
  const [day, setDay] = useState("");
  const [data, setData] = useState<Replay | null>(null);
  const [done, setDone] = useState<ReplaySettled[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [round, setRound] = useState(0);

  const load = useCallback(async (o: { tf: ReplayTf; day?: string }) => {
    setBusy(true);
    setError(null);
    try {
      const r = await api.replay(o);
      setData(r);
      setDay(r.day);
      setDone(null);
      setRound((x) => x + 1);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't load that day");
    } finally {
      setBusy(false);
    }
  }, []);

  useEffect(() => { load({ tf: "5m" }); }, [load]);

  const label = data ? new Date(`${data.day}T00:00:00Z`).toLocaleDateString("en-GB", { timeZone: "UTC", weekday: "long", day: "numeric", month: "long", year: "numeric" }) : "";

  return (
    <div className="mx-auto max-w-6xl space-y-5 px-4 py-8">
      <PageHeader icon="clock" title="Replay a day"
        subtitle="Step through real past candles one at a time and trade them with $10,000 of virtual money. You only see what a trader saw then."
        right={<Link href="/paper/challenge" className="flex basis-full items-center justify-center gap-1 sm:basis-auto rounded-full border border-gold/40 px-4 py-1.5 text-sm text-gold hover:bg-gold/10">
          <Icon name="trophy" className="h-4 w-4" /> This week&apos;s challenge</Link>} />

      <div className="card flex flex-wrap items-end gap-3 p-4">
        <div>
          <p className="mb-1 text-xs text-muted">Candles</p>
          <Chips options={TFS} value={tf} onChange={(v) => { setTf(v); load({ tf: v, day: day || undefined }); }} />
        </div>
        <label className="text-xs">
          <span className="text-muted">{tf === "1h" ? "Week starting" : "Day"}</span>
          <input type="date" value={day} min={data?.range.first} max={data?.range.last}
            onChange={(e) => setDay(e.target.value)}
            className="mt-1 block rounded-lg border border-border bg-background px-2.5 py-1.5 text-sm outline-none focus:border-gold" />
        </label>
        <button type="button" disabled={busy || !day} onClick={() => load({ tf, day })}
          className="rounded-full bg-gradient-to-b from-gold-hi to-gold px-4 py-1.5 text-sm font-semibold text-black disabled:opacity-50">Load this day</button>
        <button type="button" disabled={busy} onClick={() => load({ tf })}
          className="rounded-full border border-border px-4 py-1.5 text-sm hover:border-gold/40">Surprise me</button>
        {data && <p className="ml-auto text-xs text-muted">{label}, {TF_LABEL[data.tf]} candles{tf !== "1h" ? ", 06:00 to 21:00 UTC" : ""}</p>}
      </div>
      {error && <p role="alert" className="text-sm text-down">{error}</p>}

      {data ? (
        <div className="space-y-4">
          <ReplayPlayer key={round} bars={data.bars} context={data.context} balance={data.balance} leverage={data.leverage}
            onFinish={(_, d) => setDone(d)} />
          {done && (
            <ReplaySummary done={done} balance={data.balance}>
              <div className="mt-4 flex flex-wrap gap-2">
                <button type="button" onClick={() => { setDone(null); setRound((x) => x + 1); }}
                  className="rounded-full border border-border px-4 py-1.5 text-sm hover:border-gold/40">Replay this day again</button>
                <button type="button" onClick={() => load({ tf })}
                  className="rounded-full bg-gradient-to-b from-gold-hi to-gold px-4 py-1.5 text-sm font-semibold text-black">Try another day</button>
              </div>
            </ReplaySummary>
          )}
        </div>
      ) : !error && <div className="h-[30rem] animate-pulse rounded-2xl bg-surface-2" />}
    </div>
  );
}
