import Link from "next/link";
import PriceChart from "@/components/PriceChart";
import PriceTicker from "@/components/PriceTicker";

const features = [
  { title: "Live gold chart", body: "Hourly and daily XAU/USD candles back to 2010.", ready: true },
  { title: "Strategy backtests", body: "Test moving-average, breakout and other strategies with real spreads and swaps.", ready: false },
  { title: "News that moves gold", body: "Headlines tagged as good or bad for gold, plus the Fed and inflation calendar.", ready: false },
  { title: "Fits your risk appetite", body: "A short quiz sets your profile; every backtest says whether it fits you.", ready: false },
  { title: "Trade log", body: "Log your own trades and get the same report as a backtest.", ready: false },
  { title: "AI assistant", body: "Ask questions about your trades, backtests and the news, in plain language.", ready: false },
];

export default function Home() {
  return (
    <div className="mx-auto max-w-6xl px-4">
      <section className="py-10 sm:py-14">
        <h1 className="max-w-2xl text-3xl font-semibold tracking-tight sm:text-4xl">
          Understand gold before you trade it.
        </h1>
        <p className="mt-3 max-w-2xl text-muted">
          Chart XAU/USD, backtest strategies on 15+ years of data, and see how the news and your own risk appetite
          should shape what you do. Free, and built for learning.
        </p>
        <div className="mt-6 flex gap-3">
          <Link href="/signup" className="rounded-md bg-gold px-4 py-2 font-medium text-black hover:opacity-90">
            Create a free account
          </Link>
          <Link href="/chart" className="rounded-md border border-border px-4 py-2 hover:bg-surface">
            Open the chart
          </Link>
        </div>
      </section>

      <section className="space-y-4">
        <PriceTicker />
        <PriceChart height={420} />
      </section>

      <section className="mt-12 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {features.map((f) => (
          <div key={f.title} className="rounded-lg border border-border bg-surface p-5">
            <div className="flex items-center gap-2">
              <h2 className="font-medium">{f.title}</h2>
              {!f.ready && <span className="rounded bg-border px-1.5 py-0.5 text-[10px] uppercase text-muted">Soon</span>}
            </div>
            <p className="mt-2 text-sm text-muted">{f.body}</p>
          </div>
        ))}
      </section>
    </div>
  );
}
