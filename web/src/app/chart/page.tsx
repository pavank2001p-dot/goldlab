import type { Metadata } from "next";
import PriceChart from "@/components/PriceChart";
import PriceTicker from "@/components/PriceTicker";
import { PageHeader } from "@/components/ui";

export const metadata: Metadata = { title: "XAU/USD chart · GoldLab" };

export default function ChartPage() {
  return (
    <div className="mx-auto max-w-6xl space-y-4 px-4 py-8">
      <PageHeader icon="candles" title="Gold chart" subtitle="XAU/USD from 1-second to 1-month candles, updating live." />
      <PriceTicker />
      <PriceChart height={620} />
      <p className="text-xs text-muted">
        Chart times are in UTC. Daily candles close at 5pm New York time. Live prices are OANDA quotes via
        Finnhub. Hourly and daily history goes back to 2003, minute history covers the last 60 days and
        second history the last 2 days. Press All for every month since 1833 (World Bank monthly averages
        from 1960, yearly averages before that). Scroll left to load older data, pinch or use the zoom buttons, and
        press full screen to expand the chart.
      </p>
    </div>
  );
}
