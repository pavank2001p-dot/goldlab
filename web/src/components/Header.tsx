"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { Icon } from "./ui";
import { api } from "@/lib/api";
import { useUser } from "@/lib/useUser";

const NAV = [
  { href: "/chart", label: "Chart", icon: "candles" },
  { href: "/backtest", label: "Backtest", icon: "backtest" },
  { href: "/strategies", label: "Strategies", icon: "trophy" },
  { href: "/scenarios", label: "Scenarios", icon: "scenarios" },
  { href: "/paper", label: "Paper trading", icon: "wallet" },
  { href: "/trades", label: "Trade log", icon: "trades" },
  { href: "/news", label: "News", icon: "news" },
  { href: "/risk", label: "Risk quiz", icon: "risk" },
  { href: "/assistant", label: "Assistant", icon: "assistant" },
];

export default function Header() {
  const path = usePathname();
  const { user, setUser } = useUser();
  const router = useRouter();

  async function logout() {
    await api.logout();
    setUser(null);
    router.push("/");
    router.refresh();
  }

  return (
    <header className="sticky top-0 z-40 border-b border-border bg-background/85 backdrop-blur">
      <div className="mx-auto flex max-w-6xl flex-wrap items-center gap-x-5 gap-y-2 px-4 py-3">
        <Link href="/" className="flex items-center gap-2 font-semibold">
          <span className="inline-block h-3 w-3 rotate-45 rounded-[3px] bg-gradient-to-br from-gold to-[#b8860b] shadow-[0_0_10px_var(--gold)]" />
          GoldLab
        </Link>
        <nav className="order-last -mx-4 flex w-[calc(100%+2rem)] gap-3 overflow-x-auto whitespace-nowrap px-4 text-sm text-muted sm:order-none sm:mx-0 sm:w-auto sm:px-0">
          {NAV.map((n) => {
            const on = path === n.href || path.startsWith(n.href + "/");
            return (
              <Link key={n.href} href={n.href} aria-current={on ? "page" : undefined}
                className={`relative flex items-center gap-1.5 py-1 transition-colors ${on ? "text-foreground" : "hover:text-foreground"}`}>
                <Icon name={n.icon} className={`h-3.5 w-3.5 ${on ? "text-gold" : ""}`} />
                {n.label}
                {on && <span className="absolute -bottom-[13px] left-0 right-0 hidden h-0.5 rounded-full bg-gold sm:block" />}
              </Link>
            );
          })}
        </nav>
        <div className="ml-auto flex items-center gap-3 text-sm">
          {user === undefined ? null : user ? (
            <>
              <Link href="/account" title={user.name || user.email} aria-label="Account"
                className="flex items-center gap-1.5 text-muted hover:text-foreground">
                <Icon name="account" className="h-4 w-4" />
                <span className="hidden max-w-40 truncate 2xl:inline">{user.name || user.email}</span>
              </Link>
              <button onClick={logout} className="rounded-md border border-border px-3 py-1.5 hover:bg-surface">
                Log out
              </button>
            </>
          ) : (
            <>
              <Link href="/login" className="text-muted hover:text-foreground">Log in</Link>
              <Link href="/signup" className="rounded-md bg-gold px-3 py-1.5 font-medium text-black hover:opacity-90">
                Sign up free
              </Link>
            </>
          )}
        </div>
      </div>
    </header>
  );
}
