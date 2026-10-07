"use client";

import Link from "next/link";
import { useUser } from "@/lib/useUser";

const next = [
  { title: "Backtest a strategy", when: "Try four strategies on 15+ years of gold", href: "/backtest" },
  { title: "Log your own trades", when: "Type them in or import your broker history", href: "/trades" },
  { title: "Take the risk-profile quiz", when: "Coming soon" },
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
    <div className="mx-auto max-w-3xl px-4 py-10">
      <h1 className="text-2xl font-semibold">Hi {user.name || "there"}</h1>
      <p className="mt-1 text-sm text-muted">Signed in as {user.email}</p>
      <div className="mt-8 grid gap-3 sm:grid-cols-3">
        {next.map((n) => {
          const body = (
            <>
              <p className="font-medium">{n.title}</p>
              <p className="mt-1 text-xs text-muted">{n.when}</p>
            </>
          );
          return n.href ? (
            <Link key={n.title} href={n.href} className="rounded-lg border border-border bg-surface p-4 hover:border-gold">{body}</Link>
          ) : (
            <div key={n.title} className="rounded-lg border border-border bg-surface p-4 opacity-70">{body}</div>
          );
        })}
      </div>
      <Link href="/chart" className="mt-8 inline-block rounded-md bg-gold px-4 py-2 font-medium text-black">
        Open the gold chart
      </Link>
    </div>
  );
}
