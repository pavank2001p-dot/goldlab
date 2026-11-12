import type { Metadata } from "next";
import Landing, { type LandingContent } from "@/components/landing/Landing";

const c: LandingContent = {
  path: "/xauusd-backtest",
  kicker: "XAU/USD backtesting",
  title: "Backtest gold strategies",
  accent: "on more than 20 years of prices.",
  intro:
    "Test a trading idea on XAU/USD history before you trust it. Pick a ready-made strategy or build your own rules from indicators, and see the trades, the drawdown and how it did on the most recent stretch it never saw.",
  cta: { href: "/backtest", label: "Run a backtest" },
  second: { href: "/strategies", label: "Browse strategies" },
  points: [
    { icon: "backtest", title: "Hourly gold since 2003", body: "Backtests run on hourly XAU/USD bars, with spread and overnight costs, and the monthly price goes back to 1833 for the long view.", href: "/backtest", link: "Backtest" },
    { icon: "bolt", title: "Your own rules", body: "Combine moving averages, RSI, breakouts and other indicators into entry and exit rules without writing code, then test them in one click.", href: "/strategies/builder", link: "Strategy builder" },
    { icon: "trophy", title: "Results that hold up", body: "Each result is split into the earlier 70% and the last 30% of the period, so you can see whether a strategy only fits the past.", href: "/strategies", link: "Strategy finder" },
  ],
  steps: [
    "Pick a strategy from the finder, or start one in the builder.",
    "Choose the period, timeframe and your stop, then run it.",
    "Read the equity curve, the worst drawdown and the out-of-sample stretch, then practise the strategy on paper.",
  ],
  faq: [
    { q: "How far back does the XAU/USD data go?", a: "Hourly bars from 2003, and a monthly series back to 1833 for the long-term chart." },
    { q: "Are costs included in the backtest?", a: "Yes. Every trade pays the spread, and positions held overnight pay or earn swap, so results are closer to what a broker would charge." },
    { q: "Can I backtest without coding?", a: "Yes. The strategy builder lets you combine indicators into rules from menus. There are also 23 ready-made strategies to start from." },
    { q: "Does a good backtest mean a strategy will work?", a: "No. Past results don't guarantee future ones. That's why each result shows how the strategy did on the last 30% of the period on its own, and why the next step is paper trading." },
  ],
};

export const metadata: Metadata = {
  title: "XAU/USD backtest: test gold trading strategies free | Trading Lab",
  description: "Backtest gold (XAU/USD) strategies on hourly data since 2003 with spread and swap costs. Ready-made strategies or your own rules, no code needed.",
  alternates: { canonical: c.path },
  openGraph: { title: "Free XAU/USD backtester", description: "Test gold strategies on more than 20 years of prices.", url: c.path },
};

export default function Page() {
  return <Landing c={c} />;
}
