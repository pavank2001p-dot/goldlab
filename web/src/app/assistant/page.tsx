"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import Rich from "@/components/Rich";
import SignInPrompt from "@/components/SignInPrompt";
import { Icon, PageHeader } from "@/components/ui";
import { api, ApiError, type AssistantStatus, type Turn } from "@/lib/api";
import { useUser } from "@/lib/useUser";

const STORE = "goldlab-assistant";
const HISTORY_TURNS = 10;

const SUGGESTIONS = [
  { icon: "candles", text: "How has gold moved this year?" },
  { icon: "risk", text: "Does my latest backtest fit my risk profile?" },
  { icon: "backtest", text: "Backtest a 20/50 moving-average crossover since 2015 with a 2% stop loss." },
  { icon: "bolt", text: "Build me a strategy that buys dips in an uptrend, test it and save it." },
];

function Avatar({ who }: { who: "user" | "assistant" }) {
  return who === "assistant" ? (
    <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-gradient-to-br from-gold to-gold-deep text-black">
      <Icon name="assistant" className="h-4 w-4" />
    </span>
  ) : (
    <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-border text-muted">
      <Icon name="account" className="h-4 w-4" />
    </span>
  );
}

const TOOL_LABELS: Record<string, string> = {
  price_summary: "latest prices",
  price_history: "price history",
  list_strategies: "strategies",
  run_backtest: "ran a backtest",
  my_backtests: "your backtests",
  my_trade_log: "your trade log",
  my_paper_account: "your paper account",
  my_risk_profile: "your risk profile",
  profile_fit: "profile fit",
  gold_news: "news",
  economic_calendar: "event calendar",
  my_agent: "your strategy agent",
  diagnose_strategy: "tested a strategy",
  test_rules: "tested its own rules",
  save_strategy: "saved to your strategies",
  my_custom_strategies: "your saved strategies",
};

type Msg = Turn & { tools?: string[]; failed?: boolean };

export default function AssistantPage() {
  const { user } = useUser();
  const [status, setStatus] = useState<AssistantStatus | null>(null);
  const [msgs, setMsgs] = useState<Msg[]>([]);
  const [q, setQ] = useState("");
  const [waiting, setWaiting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const end = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!user) return;
    api.assistantStatus().then(setStatus).catch(() => {});
    try {
      const saved = sessionStorage.getItem(STORE);
      if (saved) setMsgs(JSON.parse(saved));
    } catch {}
  }, [user]);

  useEffect(() => {
    try {
      sessionStorage.setItem(STORE, JSON.stringify(msgs));
    } catch {}
    end.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [msgs, waiting]);

  if (user === null) return <SignInPrompt what="ask the AI assistant about gold and your results" next="/assistant" />;
  if (user === undefined) return null;

  async function send(question: string) {
    question = question.trim();
    if (!question || waiting) return;
    setError(null);
    // Only completed question-and-answer pairs go back as context.
    const history: Turn[] = [];
    for (let i = 0; i + 1 < msgs.length; i++)
      if (msgs[i].role === "user" && msgs[i + 1].role === "assistant" && !msgs[i + 1].failed)
        history.push({ role: "user", content: msgs[i].content }, { role: "assistant", content: msgs[i + 1].content });
    try {
      const { id } = await api.ask(question, history.slice(-HISTORY_TURNS));
      setMsgs((m) => [...m, { role: "user", content: question }]);
      setQ("");
      setWaiting(true);
      for (;;) {
        await new Promise((r) => setTimeout(r, 1500));
        const a = await api.answer(id);
        if (a.status === "pending") continue;
        setMsgs((m) => [...m, { role: "assistant", content: a.answer ?? "", tools: a.tools_used, failed: a.status === "error" }]);
        break;
      }
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Couldn't reach the assistant. Please try again.");
    } finally {
      setWaiting(false);
      api.assistantStatus().then(setStatus).catch(() => {});
    }
  }

  function clear() {
    setMsgs([]);
    setError(null);
  }

  return (
    <div className="mx-auto flex max-w-3xl flex-col px-4 py-8">
      <PageHeader icon="assistant" title="AI assistant"
        subtitle="Ask about gold prices, strategies, your backtests, your trade log or the news, or ask it to build and test a strategy for you. It looks up every number on this site rather than guessing. It explains; it never tells you to buy or sell."
        right={status?.configured ? (
          <div className="w-full sm:w-40">
            <p className="text-right text-xs tabular-nums text-muted">{status.remaining} of {status.limit} left today</p>
            <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-border">
              <div className="h-full rounded-full bg-gold transition-all" style={{ width: `${(status.remaining / Math.max(status.limit, 1)) * 100}%` }} />
            </div>
          </div>
        ) : undefined} />

      {status && !status.configured ? (
        <div className="mt-6 rounded-2xl border border-border bg-surface p-5">
          <p className="flex items-center gap-2 text-sm font-medium"><span className="h-2 w-2 rounded-full bg-gold" /> The assistant isn&apos;t switched on yet</p>
          <p className="mt-1 text-sm text-muted">It needs an Anthropic API key on the server. Once it&apos;s on, you can ask things like:</p>
          <div className="mt-4 grid gap-2 sm:grid-cols-2">
            {SUGGESTIONS.map((x) => (
              <div key={x.text} className="flex items-start gap-2.5 rounded-lg border border-border p-3 text-sm text-muted opacity-70">
                <Icon name={x.icon} className="mt-0.5 h-4 w-4 shrink-0" />{x.text}
              </div>
            ))}
          </div>
        </div>
      ) : (
        <>
          <div className="mt-6 space-y-4">
            {msgs.length === 0 && (
              <div className="grid gap-2 sm:grid-cols-2">
                {SUGGESTIONS.map((x, i) => (
                  <button key={x.text} onClick={() => send(x.text)} disabled={waiting || status?.remaining === 0}
                          style={{ animationDelay: `${i * 60}ms` }}
                          className="rise-in group flex items-start gap-2.5 rounded-2xl border border-border bg-surface p-3.5 text-left text-sm transition hover:border-gold disabled:opacity-50">
                    <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-gold/10 text-gold transition group-hover:bg-gold group-hover:text-black">
                      <Icon name={x.icon} className="h-4 w-4" />
                    </span>
                    {x.text}
                  </button>
                ))}
              </div>
            )}
            {msgs.map((m, i) =>
              m.role === "user" ? (
                <div key={i} className="rise-in flex justify-end gap-2.5">
                  <div className="max-w-[85%] rounded-2xl rounded-tr-sm bg-gold/15 px-3.5 py-2 text-sm">{m.content}</div>
                  <Avatar who="user" />
                </div>
              ) : (
                <div key={i} className="rise-in flex gap-2.5">
                  <Avatar who="assistant" />
                  <div className={`min-w-0 max-w-[92%] rounded-2xl rounded-tl-sm border px-3.5 py-1 text-sm ${m.failed ? "border-down/50" : "border-border bg-surface"}`}>
                    <Rich text={m.content} />
                    {m.tools && m.tools.length > 0 && (
                      <div className="mb-2 flex flex-wrap gap-1">
                        {[...new Set(m.tools.map((t) => TOOL_LABELS[t] ?? t))].map((t) => (
                          <span key={t} className="inline-flex items-center gap-1 rounded-full bg-background px-2 py-0.5 text-[11px] text-muted">
                            <Icon name="check" className="h-3 w-3 text-up" />{t}
                          </span>
                        ))}
                      </div>
                    )}
                  </div>
                </div>
              ),
            )}
            {waiting && (
              <div className="flex gap-2.5">
                <Avatar who="assistant" />
                <div className="flex items-center gap-2 rounded-2xl rounded-tl-sm border border-border bg-surface px-3.5 py-2.5 text-sm text-muted">
                  <span className="flex gap-1">
                    {[0, 1, 2].map((d) => <span key={d} className="typing-dot h-1.5 w-1.5 rounded-full bg-gold" style={{ animationDelay: `${d * 0.15}s` }} />)}
                  </span>
                  Looking that up
                </div>
              </div>
            )}
            <div ref={end} />
          </div>

          {error && <p className="mt-4 text-sm text-down">{error}</p>}

          <form onSubmit={(e) => { e.preventDefault(); send(q); }} className="sticky bottom-0 mt-6 flex gap-2 bg-background py-3">
            <textarea
              value={q}
              onChange={(e) => setQ(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  send(q);
                }
              }}
              rows={2}
              maxLength={2000}
              placeholder={status?.remaining === 0 ? "You've used today's questions. Back tomorrow (midnight UTC)." : "Ask about gold or your results…"}
              disabled={waiting || status?.remaining === 0}
              className="min-w-0 flex-1 resize-none rounded-2xl border border-border bg-surface px-3.5 py-2.5 text-base outline-none transition focus:border-gold focus:shadow-[0_0_0_3px_color-mix(in_srgb,var(--gold)_15%,transparent)] sm:text-sm"
            />
            <div className="flex flex-col gap-2">
              <button type="submit" disabled={waiting || !q.trim() || status?.remaining === 0}
                      className="rounded-lg bg-gold px-4 py-2 text-sm font-medium text-black disabled:opacity-50">
                Ask
              </button>
              {msgs.length > 0 && (
                <button type="button" onClick={clear} disabled={waiting} className="text-xs text-muted hover:text-foreground">
                  New chat
                </button>
              )}
            </div>
          </form>
          <p className="text-xs text-muted">
            AI answers can be wrong. Educational only, not financial advice. See the{" "}
            <Link href="/disclaimer" className="underline">disclaimer</Link>.
          </p>
        </>
      )}
    </div>
  );
}
