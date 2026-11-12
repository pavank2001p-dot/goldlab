"use client";

import Link from "next/link";
import { TourLink } from "./Tour";
import { useT } from "@/lib/i18n";

export default function Footer() {
  const { t } = useT();
  return (
    <footer className="mt-16 border-t border-border">
      <div className="mx-auto max-w-6xl px-4 py-6 text-xs leading-relaxed text-muted">
        {t("Trading Lab is an educational analysis tool. Nothing on this site is investment advice or a recommendation to buy or sell. Trading gold and other leveraged products carries a high risk of loss. Past performance and backtests do not guarantee future results. AI answers can be wrong.")}{" "}
        <Link href="/disclaimer" className="underline hover:text-foreground">{t("Read the full disclaimer")}</Link>.
        <p className="mt-2">
          Charts by{" "}
          <a href="https://www.tradingview.com/" target="_blank" rel="noopener noreferrer" className="underline hover:text-foreground">
            TradingView
          </a>{" "}
          Lightweight Charts™. New here? <TourLink className="underline hover:text-foreground" />.
        </p>
      </div>
    </footer>
  );
}
