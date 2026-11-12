import type { MetadataRoute } from "next";
import { LANDINGS } from "@/components/landing/Landing";
import { SITE_URL } from "@/lib/site";

// Public pages worth finding from a search; account and per-user pages are left out.
const PAGES = ["/", "/chart", "/news", "/strategies", "/backtest", "/strategies/builder", "/scenarios", "/paper",
  "/learn", "/paper/replay", "/paper/challenge", "/risk", "/disclaimer"];

export default function sitemap(): MetadataRoute.Sitemap {
  return [...PAGES, ...LANDINGS.map((l) => l.path)].map((p) => ({
    url: `${SITE_URL}${p === "/" ? "" : p}`,
    changeFrequency: "weekly",
    priority: p === "/" ? 1 : LANDINGS.some((l) => l.path === p) ? 0.8 : 0.6,
  }));
}
