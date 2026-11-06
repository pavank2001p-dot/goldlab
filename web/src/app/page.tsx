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
    links: [{ href: "/strategies", label: "Strategy finder" }, { href: "/backtest", label: "Backtest" }, { href: "/strategies/builder", label: "Build your own" }, { href: "/scenarios", label: "Scenarios" }],
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
      <section className="relative py-16 sm:py-24">
        <div aria-hidden className="pointer-events-none absolute -top-32 left-1/2 h-80 w-[48rem] max-w-full -translate-x-1/2 rounded-full bg-gold/10 blur-3xl" />
        <div aria-hidden className="pointer-events-none absolute inset-0 bg-[linear-gradient(to_right,rgb(255_255_255/0.025)_1px,transparent_1px),linear-gradient(to_bottom,rgb(255_255_255/0.025)_1px,transparent_1px)] bg-[size:56px_56px] [mask-image:radial-gradient(ellipse_at_top,black,transparent_70%)]" />
        <div className="relative">
          <span className="inline-flex items-center gap-2 rounded-full border border-gold/30 bg-gold/10 px-3 py-1 text-xs font-medium text-gold">
            <span className="h-1.5 w-1.5 rounded-full bg-gold" /> Free, and built for learning
          </span>
          <h1 className="mt-5 max-w-3xl text-4xl font-bold tracking-tight sm:text-6xl">
            Understand gold{" "}
            <span className="bg-gradient-to-r from-gold via-[#f5d77a] to-gold bg-clip-text text-transparent">before you trade it.</span>
          </h1>
          <p className="mt-6 max-w-xl text-lg leading-relaxed text-muted">
            Learn, test and practise at your own pace. Numbers come from real prices, the risk is shown before you act,
            and nothing here uses real money.
          </p>
          <div className="mt-9 flex flex-wrap gap-3">
            <Link href="/risk" className="group flex items-center gap-2 rounded-full bg-gradient-to-b from-[#f2c95a] to-gold px-6 py-3 font-semibold text-black shadow-[0_10px_30px_-12px_var(--gold),inset_0_1px_0_rgb(255_255_255/0.35)] transition-[filter] hover:brightness-105">
              Start with your risk profile
              <Icon name="arrow" className="h-4 w-4 transition-transform duration-300 group-hover:translate-x-0.5" />
            </Link>
            <Link href="/chart" className="rounded-full border border-border bg-surface/60 px-6 py-3 font-medium backdrop-blur transition-colors hover:border-gold/40">
              Open the chart
            </Link>
          </div>
          <dl className="mt-12 grid max-w-3xl grid-cols-2 gap-y-6 border-t border-border pt-8 sm:grid-cols-4">
            {[["1833", "Price history since"], ["23", "Strategies, plus your own"], ["2,000", "Paths per scenario"], ["$0", "Real money at risk"]].map(([v, l]) => (
              <div key={l} className="sm:border-l sm:border-border sm:pl-5 sm:first:border-l-0 sm:first:pl-0">
                <dt className="sr-only">{l}</dt>
                <dd className="text-2xl font-bold tabular-nums tracking-tight">{v}</dd>
                <dd className="mt-0.5 text-xs uppercase tracking-wider text-muted">{l}</dd>
              </div>
            ))}
          </dl>
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
            <div key={p.n} className="card group flex flex-col p-6 transition-colors hover:border-gold/40">
              <div className="flex items-center justify-between">
                <span className="flex h-11 w-11 items-center justify-center rounded-xl border border-gold/25 bg-gradient-to-br from-gold/20 to-gold/5 text-gold">
                  <Icon name={p.icon} className="h-5 w-5" />
                </span>
                <span className="font-mono text-3xl font-bold text-border transition-colors group-hover:text-gold/40">0{p.n}</span>
              </div>
              <h3 className="mt-5 text-lg font-semibold">{p.title}</h3>
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

      <section className="mt-20 grid gap-8 card rounded-3xl p-6 sm:p-10 md:grid-cols-[1fr_2fr]">
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
              <span className="flex h-9 w-9 items-center justify-center rounded-lg border border-border bg-background text-gold"><Icon name={h.icon} className="h-4 w-4" /></span>
              <p className="mt-3 font-semibold">{h.title}</p>
              <p className="mt-1 text-sm leading-relaxed text-muted">{h.body}</p>
            </li>
          ))}
        </ul>
      </section>

      <section className="mt-20 mb-6 flex flex-col items-start justify-between gap-4 rounded-3xl border border-gold/30 bg-gradient-to-r from-gold/15 via-gold/5 to-transparent p-6 sm:flex-row sm:items-center sm:p-8">
        <div>
          <h2 className="text-lg font-medium">Keep your work in one place</h2>
          <p className="mt-1 text-sm text-muted">A free account saves your risk profile, backtests, paper account and trades.</p>
        </div>
        <Link href="/signup" className="rounded-full bg-gradient-to-b from-[#f2c95a] to-gold px-5 py-2.5 font-semibold text-black shadow-[inset_0_1px_0_rgb(255_255_255/0.35)] transition-[filter] hover:brightness-105">
          Create a free account
        </Link>
      </section>
    </div>
  );
}
