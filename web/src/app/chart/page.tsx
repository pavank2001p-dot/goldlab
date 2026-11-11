import type { Metadata } from "next";
import ChartView from "./ChartView";

export const metadata: Metadata = { title: "Charts · GoldLab" };

export default function ChartPage() {
  return <ChartView />;
}
