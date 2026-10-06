import type { Metadata } from "next";
import PriceChart from "@/components/PriceChart";
import PriceTicker from "@/components/PriceTicker";

export const metadata: Metadata = { title: "XAU/USD chart · GoldLab" };

export default function ChartPage() {
  return (
    <div className="mx-auto max-w-6xl space-y-4 px-4 py-8">
      <PriceTicker />
      <PriceChart height={620} />
      <p className="text-xs text-muted">
        Chart times are in UTC. Daily candles close at 5pm New York time. Scroll left to load older
        data, back to 2010. The chart refreshes every minute.
      </p>
    </div>
  );
}
