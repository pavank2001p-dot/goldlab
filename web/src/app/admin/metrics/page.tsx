"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { Chips, Empty, PageHeader } from "@/components/ui";
import { api, ApiError, type Funnel } from "@/lib/api";

const pct = (v: number | null) => (v == null ? "–" : `${v}%`);

function Stat({ label, value, note }: { label: string; value: string; note?: string }) {
  return (
    <div className="card p-4">
      <p className="text-xs uppercase tracking-wider text-muted">{label}</p>
      <p className="mt-1 text-2xl font-bold tabular-nums">{value}</p>
      {note && <p className="mt-0.5 text-xs text-muted">{note}</p>}
    </div>
  );
}

/** Sign-ups, first paper trades and day-7 returns by week, and which pages people arrive on. Admins only. */
export default function MetricsPage() {
  const [weeks, setWeeks] = useState<"8" | "12" | "26">("8");
  const [data, setData] = useState<Funnel | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    api.funnel(Number(weeks)).then(setData, (e) =>
      setError(e instanceof ApiError && e.status === 401 ? "Log in with an admin account to see product metrics." : e instanceof Error ? e.message : String(e)));
  }, [weeks]);
  if (error)
    return (
      <div className="mx-auto max-w-3xl px-4 py-14">
        <Empty icon="chart" title="Product metrics">
          {error} Admins are set with the API&apos;s <code>ADMIN_EMAILS</code> setting. <Link href="/login?next=/admin/metrics" className="text-gold underline">Log in</Link>
        </Empty>
      </div>
    );
  if (!data) return <div className="mx-auto max-w-6xl px-4 py-10 text-muted">Loading…</div>;
  const t = data.totals;
  const max = Math.max(1, ...data.cohorts.map((c) => c.signups));
  return (
    <div className="mx-auto max-w-6xl px-4 py-8">
      <PageHeader icon="chart" title="Product metrics" subtitle="Sign-ups, first paper trades and who comes back in week two. Counted on our own server, with no tracking scripts."
        right={<Chips options={[{ key: "8", label: "8 weeks" }, { key: "12", label: "12 weeks" }, { key: "26", label: "26 weeks" }]} value={weeks} onChange={setWeeks} />} />
      <div className="mt-6 grid grid-cols-2 gap-3 md:grid-cols-5">
        <Stat label="Sign-ups" value={String(t.signups)} note={`last ${weeks} weeks`} />
        <Stat label="Made a paper trade" value={pct(t.first_trade_pct)} note={`${t.first_trade} of ${t.signups}, ${t.first_trade_day1} on day one`} />
        <Stat label="Day-7 return" value={pct(t.day7_pct)} note={`${t.day7_returned} of ${t.day7_eligible} back in days 7 to 13`} />
        <Stat label="Active this week" value={String(data.active.week)} note={`${data.active.today} today`} />
        <Stat label="Active this month" value={String(data.active.month)} />
      </div>

      <section className="card mt-6 overflow-x-auto p-4">
        <h2 className="font-semibold">Weekly sign-up cohorts</h2>
        <table className="mt-3 w-full min-w-[560px] text-sm">
          <thead className="text-left text-xs text-muted">
            <tr><th className="py-2 font-medium">Week of</th><th className="font-medium">Sign-ups</th><th className="font-medium">First paper trade</th><th className="font-medium">Day-7 return</th></tr>
          </thead>
          <tbody className="tabular-nums">
            {data.cohorts.slice().reverse().map((c) => (
              <tr key={c.week} className="border-t border-border">
                <td className="py-2">{new Date(c.week + "T00:00:00Z").toLocaleDateString(undefined, { day: "numeric", month: "short", timeZone: "UTC" })}</td>
                <td>
                  <span className="inline-flex items-center gap-2">
                    <span className="h-2 rounded-full bg-gold/70" style={{ width: `${(c.signups / max) * 80}px` }} />
                    {c.signups}
                  </span>
                </td>
                <td>{c.first_trade} <span className="text-muted">({pct(c.first_trade_pct)})</span></td>
                <td>{!c.signups ? <span className="text-muted">–</span> : c.day7_eligible ? <>{c.day7_returned} <span className="text-muted">({pct(c.day7_pct)})</span></> : <span className="text-muted">too recent</span>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      <section className="card mt-6 overflow-x-auto p-4">
        <h2 className="font-semibold">Page views, last {data.page_days} days</h2>
        <p className="mt-1 text-xs text-muted">Where each view came from. Internal means moving between pages on the site.</p>
        {data.pages.length === 0 ? <p className="mt-4 text-sm text-muted">No views counted yet.</p> : (
          <table className="mt-3 w-full min-w-[560px] text-sm">
            <thead className="text-left text-xs text-muted">
              <tr>{["Page", "Views", "Search", "Social", "Other sites", "Direct", "Internal"].map((h) => <th key={h} className="py-2 font-medium">{h}</th>)}</tr>
            </thead>
            <tbody className="tabular-nums">
              {data.pages.map((p) => (
                <tr key={p.path} className="border-t border-border">
                  <td className="py-2 font-mono text-xs">{p.path}</td><td>{p.views}</td><td>{p.search}</td><td>{p.social}</td><td>{p.other}</td><td>{p.direct}</td><td>{p.internal}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </div>
  );
}
