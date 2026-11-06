"use client";

import Link from "next/link";
import { Icon } from "@/components/ui";
import { useUser } from "@/lib/useUser";

const next = [
  { title: "Take the risk-profile quiz", when: "17 questions to set your risk limits", href: "/risk", icon: "risk" },
  { title: "Backtest a strategy", when: "Try 15 strategies on 15+ years of gold", href: "/backtest", icon: "backtest" },
  { title: "Explore a trade's scenarios", when: "2,000 simulated paths from gold's own history", href: "/scenarios", icon: "scenarios" },
  { title: "Practise with paper trading", when: "Virtual money, real gold prices", href: "/paper", icon: "wallet" },
  { title: "Log your own trades", when: "Type them in or import your broker history", href: "/trades", icon: "trades" },
  { title: "Read the news", when: "Headlines tagged good or bad for gold", href: "/news", icon: "news" },
  { title: "Ask the assistant", when: "Plain-language answers about your results", href: "/assistant", icon: "assistant" },
];

export default function AccountPage() {
  const { user } = useUser();
  if (user === undefined) return null;
  if (user === null)
    return (
      <div className="mx-auto max-w-3xl px-4 py-14">
        <p>
          Please <Link href="/login?next=/account" className="text-gold">log in</Link> to see your dashboard.
        </p>
      </div>
    );
  return (
    <div className="mx-auto max-w-4xl px-4 py-10">
      <div className="flex items-center gap-4">
        <span className="flex h-12 w-12 items-center justify-center rounded-full bg-gradient-to-br from-gold to-[#b39257] text-lg font-semibold text-black">
          {(user.name || user.email)[0].toUpperCase()}
        </span>
        <div>
          <h1 className="text-2xl font-semibold">Hi {user.name || "there"}</h1>
          <p className="text-sm text-muted">Signed in as {user.email}</p>
        </div>
      </div>
      <h2 className="mt-10 text-sm font-medium text-muted">Where to next</h2>
      <div className="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {next.map((n) => {
          const body = (
            <>
              <span className="flex h-9 w-9 items-center justify-center rounded-lg bg-gold/10 text-gold transition group-hover:bg-gold group-hover:text-black">
                <Icon name={n.icon} className="h-5 w-5" />
              </span>
              <p className="mt-3 font-medium">{n.title}</p>
              <p className="mt-1 text-xs text-muted">{n.when}</p>
            </>
          );
          return n.href ? (
            <Link key={n.title} href={n.href} className="group rounded-2xl border border-border bg-surface p-4 transition hover:border-gold/60">{body}</Link>
          ) : (
            <div key={n.title} className="rounded-lg border border-border bg-surface p-4 opacity-70">{body}</div>
          );
        })}
      </div>
      <Link href="/chart" className="mt-8 inline-block rounded-lg bg-gold px-4 py-2 font-medium text-black">
        Open the gold chart
      </Link>
    </div>
  );
}
