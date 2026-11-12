/** The five stages of the Lab loop, shared by the signed-in Lab home and the welcome page. */
import type { LabStageKey } from "./api";

export const STAGE_ICON: Record<LabStageKey | "limits", string> = {
  limits: "risk", spark: "assistant", build: "bolt", test: "backtest", play: "wallet", review: "trades",
};

/** The five stages for visitors who aren't signed in: what each is for and where it lives. */
export const LOOP = [
  { key: "spark", name: "Spark", body: "Find an idea: a lesson from gold's history, a headline, or a question to the AI.",
    links: [{ href: "/learn", label: "Lessons" }, { href: "/news", label: "News" }, { href: "/assistant", label: "Assistant" }] },
  { key: "build", name: "Build", body: "Turn it into rules of your own, from a template or from scratch.",
    links: [{ href: "/strategies/builder", label: "Strategy studio" }] },
  { key: "test", name: "Test", body: "See how it would have done on 20 years of prices, with real costs.",
    links: [{ href: "/backtest", label: "Backtest" }, { href: "/strategies", label: "Finder" }, { href: "/scenarios", label: "Scenarios" }] },
  { key: "play", name: "Play", body: "Trade it with virtual money: paper, a replayed day, a prop challenge.",
    links: [{ href: "/paper", label: "Paper" }, { href: "/paper/replay", label: "Replay" }, { href: "/paper/prop", label: "Prop" }] },
  { key: "review", name: "Review", body: "Grade the decision, not the result, and write down what you learned.",
    links: [{ href: "/coach", label: "Coach" }, { href: "/trades", label: "Journal" }] },
] as const;
