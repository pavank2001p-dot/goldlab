import type { Metadata } from "next";
import Landing, { type LandingContent } from "@/components/landing/Landing";

const c: LandingContent = {
  path: "/gold-trading-simulator",
  kicker: "Free gold trading simulator",
  title: "Practise trading gold",
  accent: "with live prices and no real money.",
  intro:
    "Trading Lab gives you a virtual account on live XAU/USD prices. Place market, limit and stop orders, set a stop and target, trail your stop, close part of a trade, and see your result in dollars, all without risking anything.",
  cta: { href: "/paper", label: "Open the simulator" },
  second: { href: "/paper/replay", label: "Replay a past day" },
  points: [
    { icon: "wallet", title: "A real order ticket", body: "Market, limit and stop orders with stop loss, take profit, trailing stops, break-even, partial closes and one-cancels-other pairs. Spread and overnight costs are charged like a broker would.", href: "/paper", link: "Paper trading" },
    { icon: "clock", title: "Replay any past day", body: "Pick a day like a Fed decision or a big jobs report and trade it candle by candle, at your own speed, to practise when markets move fast.", href: "/paper/replay", link: "Replay a day" },
    { icon: "risk", title: "Size from your stop", body: "Set how much you are willing to lose on one trade. The ticket sizes the position from the distance to your stop so one bad trade stays small.", href: "/risk", link: "Set your risk limits" },
  ],
  steps: [
    "Open paper trading. You get a virtual account straight away; sign up to keep it.",
    "Choose buy or sell, put your stop where the idea would be wrong, and let the ticket size the trade.",
    "Watch it play out on the live chart, then review what went well and what to change in your history.",
  ],
  faq: [
    { q: "Is the gold trading simulator free?", a: "Yes. Paper trading, replays, backtests and lessons are free, and nothing uses real money." },
    { q: "Are the prices real?", a: "Yes. The simulator uses live XAU/USD quotes during market hours, and hourly history back to 2003 for replays and backtests. If live data isn't available the page says so." },
    { q: "Does it include spread and swap costs?", a: "Yes. Each fill pays the spread, positions held overnight pay or earn a swap, and the cost is shown on each trade so results aren't flattered." },
    { q: "Can I practise other markets?", a: "Gold is the focus, but the chart and simulator also cover other metals, forex, indices, stocks and crypto." },
    { q: "Is this investment advice?", a: "No. Trading Lab is an educational tool. Leveraged trading carries a high risk of loss, and practice results don't guarantee real ones." },
  ],
};

export const metadata: Metadata = {
  title: "Gold trading simulator: practise XAU/USD free | Trading Lab",
  description: "Free gold trading simulator with live XAU/USD prices, a real order ticket, stops, trailing stops and replays of past days. No real money, no card.",
  alternates: { canonical: c.path },
  openGraph: { title: "Free gold trading simulator", description: "Practise trading gold on live prices with virtual money.", url: c.path },
};

export default function Page() {
  return <Landing c={c} />;
}
