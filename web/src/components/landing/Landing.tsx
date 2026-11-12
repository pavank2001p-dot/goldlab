import Link from "next/link";
import { Icon } from "@/components/ui";

export type LandingContent = {
  path: string;
  kicker: string;
  title: string;
  accent: string;
  intro: string;
  cta: { href: string; label: string };
  second: { href: string; label: string };
  points: { icon: string; title: string; body: string; href: string; link: string }[];
  steps: string[];
  faq: { q: string; a: string }[];
};

/** A plain, fast page for one search phrase: what it is, what you can do, how to start, and answers. */
export default function Landing({ c }: { c: LandingContent }) {
  const jsonLd = {
    "@context": "https://schema.org",
    "@type": "FAQPage",
    mainEntity: c.faq.map((f) => ({ "@type": "Question", name: f.q, acceptedAnswer: { "@type": "Answer", text: f.a } })),
  };
  return (
    <div className="mx-auto max-w-5xl px-4">
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd) }} />
      <section className="relative py-14 sm:py-20">
        <div aria-hidden className="pointer-events-none absolute -top-32 left-1/2 h-80 w-[40rem] max-w-full -translate-x-1/2 rounded-full bg-gold/10 blur-3xl" />
        <div className="relative">
          <span className="inline-flex items-center gap-2 rounded-full border border-gold/30 bg-gold/10 px-3 py-1 text-xs font-medium text-gold">
            <span className="h-1.5 w-1.5 rounded-full bg-gold" /> {c.kicker}
          </span>
          <h1 className="mt-5 max-w-3xl text-4xl font-bold tracking-tight sm:text-5xl">
            {c.title}{" "}
            <span className="bg-gradient-to-r from-gold via-[#f5d77a] to-gold bg-clip-text text-transparent">{c.accent}</span>
          </h1>
          <p className="mt-6 max-w-2xl text-lg leading-relaxed text-muted">{c.intro}</p>
          <div className="mt-8 flex flex-wrap gap-3">
            <Link href={c.cta.href} className="group flex items-center gap-2 rounded-full bg-gradient-to-b from-gold-hi to-gold px-6 py-3 font-semibold text-black transition-[filter] hover:brightness-105">
              {c.cta.label}
              <Icon name="arrow" className="h-4 w-4 transition-transform duration-300 group-hover:translate-x-0.5" />
            </Link>
            <Link href={c.second.href} className="rounded-full border border-border bg-surface/60 px-6 py-3 font-medium transition-colors hover:border-gold/40">
              {c.second.label}
            </Link>
          </div>
          <p className="mt-4 text-sm text-muted">Free to use. No card, no real money, nothing to install.</p>
        </div>
      </section>

      <section className="grid gap-5 md:grid-cols-3">
        {c.points.map((p) => (
          <div key={p.title} className="card flex flex-col p-5">
            <span className="flex h-10 w-10 items-center justify-center rounded-xl bg-gold/10 text-gold">
              <Icon name={p.icon} className="h-5 w-5" />
            </span>
            <h2 className="mt-4 font-semibold">{p.title}</h2>
            <p className="mt-2 flex-1 text-sm leading-relaxed text-muted">{p.body}</p>
            <Link href={p.href} className="mt-4 text-sm font-medium text-gold hover:underline">{p.link} →</Link>
          </div>
        ))}
      </section>

      <section className="mt-16">
        <h2 className="text-2xl font-bold">How to start</h2>
        <ol className="mt-6 space-y-3">
          {c.steps.map((s, i) => (
            <li key={i} className="flex gap-4">
              <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full border border-gold/40 text-sm font-semibold text-gold">{i + 1}</span>
              <span className="pt-0.5 leading-relaxed">{s}</span>
            </li>
          ))}
        </ol>
      </section>

      <section className="mt-16">
        <h2 className="text-2xl font-bold">Questions</h2>
        <div className="mt-6 divide-y divide-border rounded-2xl border border-border">
          {c.faq.map((f) => (
            <details key={f.q} className="group p-5">
              <summary className="flex cursor-pointer list-none items-center justify-between gap-4 font-medium">
                {f.q}
                <Icon name="down" className="h-4 w-4 shrink-0 text-muted transition-transform group-open:rotate-180" />
              </summary>
              <p className="mt-3 leading-relaxed text-muted">{f.a}</p>
            </details>
          ))}
        </div>
      </section>

      <section className="card mt-16 flex flex-col items-start gap-4 p-6 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h2 className="text-xl font-bold">Try it on today&apos;s prices</h2>
          <p className="mt-1 text-sm text-muted">Everything works without an account. Sign up to save your work.</p>
        </div>
        <Link href={c.cta.href} className="rounded-full bg-gold px-6 py-2.5 font-semibold text-black hover:opacity-90">{c.cta.label}</Link>
      </section>

      <nav aria-label="Related" className="mt-10 flex flex-wrap gap-x-5 gap-y-2 text-sm text-muted">
        {LANDINGS.filter((l) => l.path !== c.path).map((l) => (
          <Link key={l.path} href={l.path} className="hover:text-foreground">{l.label}</Link>
        ))}
      </nav>
    </div>
  );
}

/** The search-landing pages, for the sitemap and cross-links. */
export const LANDINGS = [
  { path: "/gold-trading-simulator", label: "Gold trading simulator" },
  { path: "/xauusd-backtest", label: "XAU/USD backtest" },
  { path: "/prop-firm-practice-gold", label: "Prop firm practice for gold" },
];
