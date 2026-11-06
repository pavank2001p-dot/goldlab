import Link from "next/link";
import PriceChart from "@/components/PriceChart";
import PriceTicker from "@/components/PriceTicker";
import { Icon } from "@/components/ui";

const features = [
  { title: "Live gold chart", body: "Live XAU/USD candles from 1 second to 1 month, with monthly history back to 1833.", href: "/chart", icon: "candles" },
  { title: "Strategy backtests", body: "Test 15 trend and mean-reversion strategies with real spreads and swaps.", href: "/backtest", icon: "backtest" },
  { title: "Trade scenarios", body: "See the range of prices and returns gold's past moves make possible for a trade you open today.", href: "/scenarios", icon: "scenarios" },
  { title: "Paper trading", body: "Practise with $10,000 of virtual money: market, limit and stop orders on live gold prices.", href: "/paper", icon: "wallet" },
  { title: "Trade log", body: "Log your own trades or import them from your broker, and get the same report as a backtest.", href: "/trades", icon: "trades" },
  { title: "News that moves gold", body: "Headlines tagged as good or bad for gold, plus the Fed and inflation calendar.", href: "/news", icon: "news" },
  { title: "Fits your risk appetite", body: "A 17-question quiz sets your profile and the limits your trading is measured against.", href: "/risk", icon: "risk" },
  { title: "AI assistant", body: "Ask questions about your trades, backtests and the news, in plain language.", href: "/assistant", icon: "assistant" },
];

const steps = [
  { n: 1, title: "Find your risk profile", body: "Answer 17 questions to set your limits." },
  { n: 2, title: "Test ideas on history", body: "Backtest strategies and explore scenarios." },
  { n: 3, title: "Check your real trades", body: "Log them and see if they fit your limits." },
];

export default function Home() {
  return (
    <div className="mx-auto max-w-6xl px-4">
      <section className="relative py-12 sm:py-16">
        <div aria-hidden className="pointer-events-none absolute -top-24 left-1/2 h-72 w-[42rem] max-w-full -translate-x-1/2 rounded-full bg-gold/15 blur-3xl" />
        <div className="relative">
          <span className="inline-flex items-center gap-2 rounded-full border border-gold/30 bg-gold/10 px-3 py-1 text-xs text-gold">
            <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-gold" /> Free, and built for learning
          </span>
          <h1 className="mt-4 max-w-2xl text-4xl font-semibold tracking-tight sm:text-5xl">
            Understand gold <span className="bg-gradient-to-r from-gold to-[#f5d77a] bg-clip-text text-transparent">before you trade it.</span>
          </h1>
          <p className="mt-4 max-w-2xl text-muted">
            Chart XAU/USD live, backtest 15 strategies on 15+ years of data, practise with virtual money, explore what could happen to a trade, and see how
            the news and your own risk limits relate to it all.
          </p>
          <div className="mt-7 flex flex-wrap gap-3">
            <Link href="/signup" className="group flex items-center gap-2 rounded-md bg-gold px-5 py-2.5 font-medium text-black shadow-[0_8px_30px_-10px_var(--gold)] transition hover:-translate-y-0.5">
              Create a free account
              <Icon name="arrow" className="h-4 w-4 transition-transform group-hover:translate-x-0.5" />
            </Link>
            <Link href="/chart" className="rounded-md border border-border px-5 py-2.5 transition hover:border-muted hover:bg-surface">
              Open the chart
            </Link>
          </div>
        </div>
      </section>

      <section className="space-y-4">
        <PriceTicker />
        <PriceChart height={420} />
      </section>

      <section className="mt-14">
        <h2 className="text-lg font-semibold">Everything in one place</h2>
        <div className="mt-4 grid gap-4 sm:grid-cols-2 lg:grid-cols-5">
          {features.map((f) => (
            <Link key={f.title} href={f.href}
              className="group relative overflow-hidden rounded-xl border border-border bg-surface p-5 transition hover:-translate-y-0.5 hover:border-gold/50 hover:shadow-[0_12px_40px_-20px_var(--gold)]">
              <span className="flex h-9 w-9 items-center justify-center rounded-lg bg-gold/10 text-gold transition group-hover:bg-gold group-hover:text-black">
                <Icon name={f.icon} className="h-5 w-5" />
              </span>
              <h3 className="mt-4 font-medium">{f.title}</h3>
              <p className="mt-1.5 text-sm text-muted">{f.body}</p>
              <span className="mt-3 flex items-center gap-1 text-xs text-gold opacity-0 transition group-hover:opacity-100">
                Open <Icon name="arrow" className="h-3 w-3" />
              </span>
            </Link>
          ))}
          <Link href="/signup"
            className="flex flex-col justify-between rounded-xl border border-gold/40 lg:col-span-2 bg-gradient-to-br from-gold/20 to-gold/5 p-5 transition hover:-translate-y-0.5">
            <div>
              <h3 className="font-medium">Start in a minute</h3>
              <p className="mt-1.5 text-sm text-muted">A free account saves your backtests, trades and risk profile.</p>
            </div>
            <span className="mt-4 flex items-center gap-1 text-sm font-medium text-gold">Sign up free <Icon name="arrow" className="h-4 w-4" /></span>
          </Link>
        </div>
      </section>

      <section className="mt-14 mb-4 rounded-xl border border-border bg-surface p-6">
        <h2 className="text-lg font-semibold">How to use GoldLab</h2>
        <ol className="mt-5 grid gap-6 sm:grid-cols-3">
          {steps.map((s) => (
            <li key={s.n} className="flex gap-3">
              <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full border border-gold/40 text-sm font-semibold text-gold">{s.n}</span>
              <div>
                <p className="font-medium">{s.title}</p>
                <p className="mt-0.5 text-sm text-muted">{s.body}</p>
              </div>
            </li>
          ))}
        </ol>
      </section>
    </div>
  );
}
