import type { Metadata } from "next";
import Landing, { type LandingContent } from "@/components/landing/Landing";

const c: LandingContent = {
  path: "/prop-firm-practice-gold",
  kicker: "Prop firm practice",
  title: "Practise gold the way a prop firm judges you:",
  accent: "small losses, steady rules.",
  intro:
    "Funded-account challenges fail most traders on risk, not on picking direction. Trading Lab lets you practise XAU/USD with fixed loss limits, sizing from your stop and a full trade history to review, before you pay for a challenge.",
  cta: { href: "/risk", label: "Set your loss limits" },
  second: { href: "/paper", label: "Start paper trading" },
  points: [
    { icon: "risk", title: "Limits first", body: "Set the most you'll lose on one trade and overall. The order ticket sizes each trade from your stop so a single loss stays inside your limit.", href: "/risk", link: "Risk profile" },
    { icon: "clock", title: "News-day practice", body: "Gold moves hardest around the Fed, inflation and jobs releases. Replay those days candle by candle and see the calendar ahead before you trade.", href: "/paper/replay", link: "Replay a day" },
    { icon: "trophy", title: "Same day, same rules", body: "The weekly challenge gives everyone the same past day to trade, with an opt-in leaderboard, so you can compare your discipline with others.", href: "/paper/challenge", link: "Weekly challenge" },
  ],
  steps: [
    "Take the risk quiz and set limits like the challenge you're aiming for, such as 1% per trade.",
    "Trade gold on paper for a few weeks, with a stop on every trade, and keep to the limits.",
    "Review your history: did every trade have a stop, and did any loss go past your limit? Fix that before you buy a real challenge.",
  ],
  faq: [
    { q: "Is this a prop firm?", a: "No. Trading Lab doesn't fund accounts or take challenge fees. It's a free place to practise the habits prop firm rules reward, with virtual money." },
    { q: "Why practise gold specifically?", a: "XAU/USD is one of the most traded instruments in prop challenges and one of the fastest-moving, so the gap between a planned loss and a real one is often biggest on gold." },
    { q: "Can I copy a firm's daily loss rules?", a: "You can set your per-trade and overall loss limits in the risk profile, and the ticket sizes trades to stay inside them." },
    { q: "Will practice here get me funded?", a: "Nothing can promise that. Practice builds habits, but real challenges add pressure and costs. Trading carries a high risk of loss." },
  ],
};

export const metadata: Metadata = {
  title: "Prop firm practice for gold (XAU/USD), free | Trading Lab",
  description: "Practise gold trading for a prop firm challenge with virtual money: loss limits, sizing from your stop, news-day replays and a weekly challenge.",
  alternates: { canonical: c.path },
  openGraph: { title: "Prop firm practice for gold", description: "Practise the risk habits funded challenges reward, free.", url: c.path },
};

export default function Page() {
  return <Landing c={c} />;
}
