"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import ThemeMenu from "./ThemeMenu";
import { Icon } from "./ui";
import { api } from "@/lib/api";
import { useUser } from "@/lib/useUser";
import { APP_NAME, labName, useMarket } from "@/lib/markets";
import { msg, useT, type T } from "@/lib/i18n";

// Pages that follow the market picker, so the header names that market's lab there.
const MARKET_PAGES = ["/chart", "/paper", "/backtest"];

type Item = { href: string; label: string; icon: string; blurb: string };

/** Twelve tools grouped into four plain steps, so the bar stays short and each menu says what a page is for. */
export const GROUPS: { label: string; items: Item[] }[] = [
  {
    label: msg("Market"),
    items: [
      { href: "/chart", label: msg("Chart"), icon: "candles", blurb: msg("Any market live, and gold back to 1833") },
      { href: "/news", label: msg("News and calendar"), icon: "news", blurb: msg("What's moving gold, and the Fed dates ahead") },
    ],
  },
  {
    label: msg("Test ideas"),
    items: [
      { href: "/strategies", label: msg("Strategy finder"), icon: "trophy", blurb: msg("Strategies that stayed inside your limits") },
      { href: "/backtest", label: msg("Backtest"), icon: "backtest", blurb: msg("Run one strategy on past prices") },
      { href: "/strategies/builder", label: msg("Strategy builder"), icon: "bolt", blurb: msg("Combine indicators into your own rules") },
      { href: "/scenarios", label: msg("Scenarios"), icon: "scenarios", blurb: msg("The range a trade could take from today") },
      { href: "/paper/sessions", label: msg("Manual backtesting"), icon: "clock", blurb: msg("Replay any dates with a higher timeframe, blind if you like") },
    ],
  },
  {
    label: msg("Practise"),
    items: [
      { href: "/paper", label: msg("Paper trading"), icon: "wallet", blurb: msg("Trade with virtual money, no risk") },
      { href: "/learn", label: msg("Lessons"), icon: "book", blurb: msg("Short stories from gold's history, then trade that week") },
      { href: "/paper/replay", label: msg("Replay a day"), icon: "clock", blurb: msg("Trade a past day candle by candle") },
      { href: "/paper/prop", label: msg("Prop challenge"), icon: "risk", blurb: msg("Hit a profit target inside daily and overall loss limits") },
      { href: "/paper/challenge", label: msg("Weekly challenge"), icon: "trophy", blurb: msg("Same day for everyone, with an opt-in leaderboard") },
      { href: "/paper/agent", label: msg("Strategy agent"), icon: "bolt", blurb: msg("Let a strategy trade on paper and learn why") },
      { href: "/trades", label: msg("Trade log"), icon: "trades", blurb: msg("Review your own real trades") },
    ],
  },
  {
    label: msg("You"),
    items: [
      { href: "/risk", label: msg("Risk profile"), icon: "risk", blurb: msg("Find the limits that suit you") },
      { href: "/record", label: msg("Verified record"), icon: "seal", blurb: msg("Your sealed track record, Skill Passport and shareable proof") },
      { href: "/coach", label: msg("Coach"), icon: "check", blurb: msg("Mistakes on your own trades, your playbook and a weekly report") },
      { href: "/assistant", label: msg("Assistant"), icon: "assistant", blurb: msg("Ask anything in plain language") },
    ],
  },
];

function active(path: string, href: string) {
  // The agent and builder live under other pages, so those parents are only active on their own page.
  if (href === "/paper" || href === "/strategies") return path === href;
  return path === href || path.startsWith(href + "/");
}

function Menu({ group, path, t }: { group: (typeof GROUPS)[number]; path: string; t: T }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const on = group.items.some((i) => active(path, i.href));
  useEffect(() => setOpen(false), [path]);
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent | KeyboardEvent) => {
      if (e instanceof KeyboardEvent ? e.key === "Escape" : !ref.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", close);
    document.addEventListener("keydown", close);
    return () => {
      document.removeEventListener("mousedown", close);
      document.removeEventListener("keydown", close);
    };
  }, [open]);
  return (
    <div ref={ref} className="relative" onMouseLeave={() => setOpen(false)}>
      <button type="button" onClick={() => setOpen(!open)} onMouseEnter={() => setOpen(true)} aria-expanded={open}
        className={`flex items-center gap-1 rounded-full px-3.5 py-1.5 transition-colors ${on ? "bg-surface-2 text-foreground" : "text-muted hover:text-foreground"}`}>
        {t(group.label)}
        <Icon name="down" className={`h-3 w-3 transition-transform duration-300 ${open ? "rotate-180" : ""}`} />
      </button>
      {open && (
        <div className="absolute left-1/2 top-full z-50 w-72 -translate-x-1/2 pt-2">
          <div className="rise-in rounded-2xl border border-border bg-surface p-2 shadow-2xl shadow-black/40">
            {group.items.map((i) => (
              <Link key={i.href} href={i.href} aria-current={active(path, i.href) ? "page" : undefined}
                className={`flex gap-3 rounded-xl p-2.5 transition-colors ${active(path, i.href) ? "bg-surface-2" : "hover:bg-surface-2"}`}>
                <span className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-gold/10 text-gold">
                  <Icon name={i.icon} className="h-4 w-4" />
                </span>
                <span>
                  <span className="block text-sm font-medium text-foreground">{t(i.label)}</span>
                  <span className="block text-xs leading-snug text-muted">{t(i.blurb)}</span>
                </span>
              </Link>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

export default function Header() {
  const path = usePathname();
  const { user, setUser } = useUser();
  const router = useRouter();
  const [mobile, setMobile] = useState(false);
  const [market] = useMarket();
  const { t } = useT();
  const lab = MARKET_PAGES.some((p) => path === p || (path.startsWith(`${p}/`) && p !== "/paper")) ? labName(market) : null;
  useEffect(() => setMobile(false), [path]);
  useEffect(() => {
    document.body.style.overflow = mobile ? "hidden" : "";
    return () => { document.body.style.overflow = ""; };
  }, [mobile]);

  async function logout() {
    await api.logout();
    setUser(null);
    router.push("/");
    router.refresh();
  }

  const account = user === undefined ? null : user ? (
    <>
      <Link href="/account" title={user.name || user.email} aria-label={t("Account")}
        className="flex h-8 w-8 items-center justify-center rounded-full border border-border text-muted transition-colors hover:text-foreground">
        <Icon name="account" className="h-4 w-4" />
      </Link>
      <button onClick={logout} className="hidden rounded-full px-3 py-1.5 text-muted transition-colors hover:text-foreground sm:block">
        {t("Log out")}
      </button>
    </>
  ) : (
    <>
      <Link href="/login" className="hidden text-muted transition-colors hover:text-foreground sm:block">{t("Log in")}</Link>
      <Link href="/signup" className="rounded-full bg-gold px-4 py-1.5 font-medium text-black transition-opacity hover:opacity-90">
        {t("Sign up free")}
      </Link>
    </>
  );

  return (
    <header className="sticky top-0 z-40 border-b border-border/60 bg-background/80 backdrop-blur-md">
      <div className="mx-auto flex max-w-6xl items-center gap-4 px-4 py-3">
        <Link href="/" className="flex items-center gap-2 font-semibold tracking-tight">
          <span className="inline-block h-3 w-3 rotate-45 rounded-[3px] bg-gradient-to-br from-gold to-gold-deep" />
          {APP_NAME}
          {lab && <span key={lab} className="rise-in hidden rounded-full border border-gold/40 px-2 py-0.5 text-[11px] font-medium text-gold sm:inline">{lab}</span>}
        </Link>
        <nav aria-label="Main" data-tour="menus" className="hidden items-center gap-1 text-sm md:flex">
          {GROUPS.map((g) => <Menu key={g.label} group={g} path={path} t={t} />)}
        </nav>
        <div className="ml-auto flex items-center gap-2 text-sm">
          <ThemeMenu />
          {account}
          <button type="button" data-tour="menus" onClick={() => setMobile(!mobile)} aria-expanded={mobile} aria-label={mobile ? t("Close menu") : t("Open menu")}
            className="flex h-8 w-8 items-center justify-center rounded-full border border-border text-muted md:hidden">
            <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden>
              {mobile ? <path d="M6 6l12 12M18 6 6 18" /> : <path d="M4 7h16M4 12h16M4 17h16" />}
            </svg>
          </button>
        </div>
      </div>
      {mobile && (
        <nav aria-label="Main" className="fan-in max-h-[calc(100dvh-57px)] overflow-y-auto border-t border-border/60 bg-background px-4 pb-8 pt-2 md:hidden">
          {GROUPS.map((g) => (
            <div key={g.label} className="mt-4">
              <p className="px-2 text-xs font-medium uppercase tracking-wider text-muted">{t(g.label)}</p>
              <div className="mt-1.5">
                {g.items.map((i) => (
                  <Link key={i.href} href={i.href} aria-current={active(path, i.href) ? "page" : undefined}
                    className={`flex items-center gap-3 rounded-xl px-2 py-2.5 ${active(path, i.href) ? "bg-surface-2" : ""}`}>
                    <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-gold/10 text-gold">
                      <Icon name={i.icon} className="h-4 w-4" />
                    </span>
                    <span>
                      <span className="block text-sm font-medium">{t(i.label)}</span>
                      <span className="block text-xs text-muted">{t(i.blurb)}</span>
                    </span>
                  </Link>
                ))}
              </div>
            </div>
          ))}
          {user && (
            <button onClick={logout} className="mt-6 w-full rounded-full border border-border py-2.5 text-sm text-muted">{t("Log out")}</button>
          )}
          {user === null && (
            <Link href="/login" className="mt-6 block w-full rounded-full border border-border py-2.5 text-center text-sm text-muted">{t("Log in")}</Link>
          )}
        </nav>
      )}
    </header>
  );
}
