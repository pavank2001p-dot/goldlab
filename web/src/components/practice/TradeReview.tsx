"use client";

import { useState } from "react";
import { api, type TradeReview as Review } from "@/lib/api";
import { Icon } from "../ui";

const TONE: Record<Review["grade"], string> = {
  A: "bg-up/15 text-up ring-up/30",
  B: "bg-gold/15 text-gold ring-gold/30",
  C: "bg-amber-500/15 text-amber-500 ring-amber-500/30",
  D: "bg-down/15 text-down ring-down/30",
};

/** A grade for one closed paper trade. Shows a "Review" button until asked, then the grade; the details open below the row. */
export default function TradeReview({ id, grade, onGraded }: { id: number; grade?: Review["grade"]; onGraded: (g: Review["grade"]) => void }) {
  const [review, setReview] = useState<Review | null>(null);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function toggle() {
    if (open) return setOpen(false);
    setOpen(true);
    if (review) return;
    setBusy(true);
    setError(null);
    try {
      const r = await api.review(id);
      setReview(r);
      onGraded(r.grade);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't review that trade");
    } finally {
      setBusy(false);
    }
  }

  const g = review?.grade ?? grade;
  return (
    <>
      <button type="button" onClick={toggle} aria-expanded={open}
        className={g ? `rounded-full px-2 py-0.5 text-[11px] font-semibold ring-1 ${TONE[g]}`
          : "flex items-center gap-1 rounded-full border border-border px-2 py-0.5 text-[11px] text-muted hover:border-gold/40 hover:text-gold"}
        title={g ? "Show the review" : "Grade how this trade was planned"}>
        {g ? `Grade ${g}` : <><Icon name="assistant" className="h-3 w-3" />Review</>}
      </button>
      {open && (
        <div className="rise-in basis-full border-t border-border pt-3 text-sm">
          {busy && <p className="animate-pulse text-muted">Looking back at this trade…</p>}
          {error && <p role="alert" className="text-down">{error}</p>}
          {review && (
            <div className="space-y-3">
              <div className="flex items-start gap-3">
                <span className={`grid h-10 w-10 shrink-0 place-items-center rounded-xl text-lg font-bold ring-1 ${TONE[review.grade]}`}>{review.grade}</span>
                <div>
                  <p className="font-medium">{review.headline}</p>
                  <p className="text-xs text-muted">
                    {[review.facts.risked_pct != null && `Risked ${review.facts.risked_pct}%`,
                      review.facts.planned_reward_to_risk != null && `target ${review.facts.planned_reward_to_risk}× the risk`,
                      review.facts.result_in_r != null && `result ${review.facts.result_in_r >= 0 ? "+" : ""}${review.facts.result_in_r}R`,
                      review.facts.trend_before_entry && `hourly trend ${review.facts.trend_before_entry}`].filter(Boolean).join(" · ") || "No stop, so the risk wasn't fixed"}
                  </p>
                </div>
              </div>
              <div className="grid gap-3 sm:grid-cols-2">
                {[{ title: "Went well", items: review.went_well, icon: "check", tone: "text-up" },
                  { title: "Work on", items: review.work_on, icon: "arrow", tone: "text-gold" }].map((c) => (
                  <div key={c.title}>
                    <p className="text-xs uppercase tracking-wider text-muted">{c.title}</p>
                    {c.items.length ? (
                      <ul className="mt-1 space-y-1">
                        {c.items.map((t) => <li key={t} className="flex gap-2"><Icon name={c.icon} className={`mt-0.5 h-3.5 w-3.5 shrink-0 ${c.tone}`} />{t}</li>)}
                      </ul>
                    ) : <p className="mt-1 text-muted">Nothing stood out.</p>}
                  </div>
                ))}
              </div>
              <p className="rounded-lg bg-gold/10 px-3 py-2"><span className="font-medium text-gold">Next time: </span>{review.next_time}</p>
              <p className="text-[11px] text-muted">
                Graded on the plan, not the profit. {review.source === "ai" ? "Written by AI from the trade's numbers." : "Scored from a checklist."} Not advice.
              </p>
            </div>
          )}
        </div>
      )}
    </>
  );
}
