import Link from "next/link";
import PriceChart from "@/components/PriceChart";
import PriceTicker from "@/components/PriceTicker";
import { Icon } from "@/components/ui";

/** Three steps instead of ten tiles: each path says what it is for and links to its tools. */
const paths = [
  {
    n: 1, title: "Know your limits", icon: "risk",
    body: "A short quiz sets how much you are comfortable losing on one trade and overall. Every other page checks against it.",
    links: [{ href: "/risk", label: "Take the risk quiz" }],
  },
  {
    n: 2, title: "Test ideas on the past", icon: "backtest",
    body: "See how a strategy would have done on more than 20 years of gold prices, with real costs, before you trust it.",
    links: [{ href: "/strategies", label: "Strategy finder" }, { href: "/backtest", label: "Backtest" }, { href: "/scenarios", label: "Scenarios" }],
  },
  {
    n: 3, title: "Practise without risk", icon: "wallet",
    body: "Trade live prices with virtual money, or let a strategy trade and explain what went wrong. Nothing real is at stake.",
    links: [{ href: "/paper", label: "Paper trading" }, { href: "/paper/agent", label: "Strategy agent" }, { href: "/trades", label: "Trade log" }],
  },
];

const habits = [
  { icon: "drop", title: "Decide the loss first", body: "Set where you would be wrong before you enter, and see it in dollars." },
  { icon: "scale", title: "Size from the stop", body: "Let the distance to your stop set the size, so one trade can't hurt much." },
  { icon: "clock", title: "There's always another trade", body: "Missing a move costs nothing. Taking a rushed one can." },
];

export default function Home() {
  return (
    <div className="mx-auto max-w-6xl px-4">
      <section className="py-14 sm:py-20">
        <p className="text-sm font-medium uppercase tracking-wider text-gold">Free, and built for learning</p>
        <h1 className="mt-3 max-w-2xl text-4xl font-bold tracking-tight sm:text-6xl">
          Understand gold, <span className="text-gold">calmly.</span>
        </h1>
        <p className="mt-5 max-w-xl text-lg leading-relaxed text-muted">
          Learn, test and practise at your own pace. Numbers come from real prices, the risk is shown before you act,
          and nothing here uses real money.
        </p>
        <div className="mt-8 flex flex-wrap gap-3">
          <Link href="/risk" className="group flex items-center gap-2 rounded-full bg-gold px-6 py-3 font-medium text-black transition-opacity hover:opacity-90">
            Start with your risk profile
            <Icon name="arrow" className="h-4 w-4 transition-transform duration-300 group-hover:translate-x-0.5" />
          </Link>
          <Link href="/chart" className="rounded-full border border-border px-6 py-3 transition-colors hover:bg-surface">
            Look at the chart
          </Link>
        </div>
      </section>

      <section className="card space-y-4 p-4 sm:p-6">
        <PriceTicker />
        <PriceChart height={380} />
      </section>

      <section className="mt-20">
        <h2 className="text-2xl font-bold">Three steps, at your own pace</h2>
        <p className="mt-2 max-w-xl text-muted">Start anywhere. Each step uses what you set in the one before.</p>
        <div className="mt-8 grid gap-5 md:grid-cols-3">
          {paths.map((p) => (
            <div key={p.n} className="card flex flex-col p-6">
              <div className="flex items-center gap-3">
                <span className="flex h-10 w-10 items-center justify-center rounded-xl bg-gold/10 text-gold">
                  <Icon name={p.icon} className="h-5 w-5" />
                </span>
                <span className="text-sm text-muted">Step {p.n}</span>
              </div>
              <h3 className="mt-5 text-lg font-medium">{p.title}</h3>
              <p className="mt-2 flex-1 text-sm leading-relaxed text-muted">{p.body}</p>
              <div className="mt-5 flex flex-wrap gap-2">
                {p.links.map((l) => (
                  <Link key={l.href} href={l.href}
                    className="flex items-center gap-1 rounded-full border border-border px-3 py-1.5 text-sm transition-colors hover:border-gold/60 hover:text-gold">
                    {l.label} <Icon name="arrow" className="h-3.5 w-3.5" />
                  </Link>
                ))}
              </div>
            </div>
          ))}
        </div>
      </section>

      <section className="mt-20 grid gap-8 rounded-3xl border border-border bg-gradient-to-br from-surface to-background p-6 sm:p-10 md:grid-cols-[1fr_2fr]">
        <div>
          <h2 className="text-2xl font-bold">Habits of a composed trader</h2>
          <p className="mt-2 text-sm leading-relaxed text-muted">
            The tools here are built around these, so the next decision feels considered rather than rushed.
          </p>
          <Link href="/assistant" className="mt-5 inline-flex items-center gap-1.5 text-sm text-gold hover:underline">
            <Icon name="assistant" className="h-4 w-4" /> Ask the assistant anything
          </Link>
        </div>
        <ul className="grid gap-6 sm:grid-cols-3">
          {habits.map((h) => (
            <li key={h.title}>
              <Icon name={h.icon} className="h-5 w-5 text-calm" />
              <p className="mt-3 font-medium">{h.title}</p>
              <p className="mt-1 text-sm leading-relaxed text-muted">{h.body}</p>
            </li>
          ))}
        </ul>
      </section>

      <section className="mt-20 mb-6 flex flex-col items-start justify-between gap-4 rounded-3xl border border-gold/25 bg-gold/5 p-6 sm:flex-row sm:items-center sm:p-8">
        <div>
          <h2 className="text-lg font-medium">Keep your work in one place</h2>
          <p className="mt-1 text-sm text-muted">A free account saves your risk profile, backtests, paper account and trades.</p>
        </div>
        <Link href="/signup" className="rounded-full bg-gold px-5 py-2.5 font-medium text-black transition-opacity hover:opacity-90">
          Create a free account
        </Link>
      </section>
    </div>
  );
}
