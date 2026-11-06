import Link from "next/link";
import { TourLink } from "./Tour";

export default function Footer() {
  return (
    <footer className="mt-16 border-t border-border">
      <div className="mx-auto max-w-6xl px-4 py-6 text-xs leading-relaxed text-muted">
        GoldLab is an educational analysis tool. Nothing on this site is investment advice or a recommendation to
        buy or sell. Trading gold and other leveraged products carries a high risk of loss. Past performance and
        backtests do not guarantee future results. AI answers can be wrong.{" "}
        <Link href="/disclaimer" className="underline hover:text-foreground">Read the full disclaimer</Link>.
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
