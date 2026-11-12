"use client";

import PriceChart from "@/components/PriceChart";
import PriceTicker from "@/components/PriceTicker";
import MarketPicker from "@/components/markets/MarketPicker";
import { SignedInAlerts } from "@/components/practice/AlertsCard";
import { PageHeader } from "@/components/ui";
import { useMarket, ticker } from "@/lib/markets";

export default function ChartView() {
  const [market, setSymbol, markets] = useMarket();
  const gold = market.symbol === "XAUUSD";
  return (
    <div className="mx-auto max-w-6xl space-y-4 px-4 py-8">
      <PageHeader icon="candles" title={`${market.name} chart`}
        subtitle={gold ? "XAU/USD from 1-second to 1-month candles, updating live."
          : `${ticker(market) !== market.name ? `${ticker(market)} · ` : ""}${market.class_label}, from 1-minute to 1-month candles.`}
        right={<MarketPicker market={market} markets={markets} onChange={setSymbol} />} />
      <PriceTicker market={market} />
      <PriceChart height={620} tools market={market} />
      {gold && <SignedInAlerts />}
      <p className="text-xs text-muted">
        {gold ? (
          <>
            Chart times are in UTC. Daily candles close at 5pm New York time. Live prices are OANDA quotes via
            Finnhub. Hourly and daily history goes back to 2003, minute history covers the last 60 days and
            second history the last 2 days. Press All for every month since 1833 (World Bank monthly averages
            from 1960, yearly averages before that).
          </>
        ) : (
          <>
            Chart times are in UTC. {market.name} trades {market.hours}.{" "}
            {market.asset_class === "crypto" ? "Daily candles close at midnight UTC." : "Daily candles close at 5pm New York time."}{" "}
            History comes from Dukascopy{market.asset_class === "stocks" || market.asset_class === "indices" || market.asset_class === "energy" ? "'s CFD prices, which track the market closely" : ""}; hourly
            and daily candles go back to 2015 where the feed has them, and minute candles cover the last 60 days.
          </>
        )}{" "}
        Scroll left to load older data, pinch or use the zoom buttons, and press full screen to expand the chart.
      </p>
    </div>
  );
}
