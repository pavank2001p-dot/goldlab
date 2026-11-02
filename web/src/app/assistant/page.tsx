"use client";

import Link from "next/link";
import { Fragment, useEffect, useRef, useState } from "react";
import SignInPrompt from "@/components/SignInPrompt";
import { api, ApiError, type AssistantStatus, type Turn } from "@/lib/api";
import { useUser } from "@/lib/useUser";

const STORE = "goldlab-assistant";
const HISTORY_TURNS = 10;

const SUGGESTIONS = [
  "How has gold moved this year?",
  "Does my latest backtest fit my risk profile?",
  "Backtest a 20/50 moving-average crossover since 2015 with a 2% stop loss.",
  "What US events this week could move gold, and why?",
];

const TOOL_LABELS: Record<string, string> = {
  price_summary: "latest prices",
  price_history: "price history",
  list_strategies: "strategies",
  run_backtest: "ran a backtest",
  my_backtests: "your backtests",
  my_trade_log: "your trade log",
  my_risk_profile: "your risk profile",
  profile_fit: "profile fit",
  gold_news: "news",
  economic_calendar: "event calendar",
};

type Msg = Turn & { tools?: string[]; failed?: boolean };

const BULLET = /^\s*(?:[-*•]|\d+\.)\s+/;

/** Renders the assistant's plain text: paragraphs, "- " bullet lists and **bold**. No HTML is injected. */
function Rich({ text }: { text: string }) {
  const inline = (s: string) =>
    s.split(/(\*\*[^*]+\*\*)/).map((part, i) =>
      part.startsWith("**") && part.endsWith("**") ? <strong key={i}>{part.slice(2, -2)}</strong> : <Fragment key={i}>{part}</Fragment>,
    );
  return (
    <>
      {text.split(/\n{2,}/).map((block, i) => {
        // Group consecutive bullet lines into a list; other lines stay as text.
        const parts: { list: boolean; lines: string[] }[] = [];
        for (const line of block.split("\n")) {
          const list = BULLET.test(line);
          const last = parts[parts.length - 1];
          if (last && last.list === list) last.lines.push(list ? line.replace(BULLET, "") : line);
          else parts.push({ list, lines: [list ? line.replace(BULLET, "") : line] });
        }
        return (
          <Fragment key={i}>
            {parts.map((p, j) =>
              p.list ? (
                <ul key={j} className="my-2 list-disc space-y-1 pl-5">
                  {p.lines.map((l, k) => <li key={k}>{inline(l)}</li>)}
                </ul>
              ) : (
                <p key={j} className="my-2 whitespace-pre-line">{inline(p.lines.join("\n"))}</p>
              ),
            )}
          </Fragment>
        );
      })}
    </>
  );
}

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
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h1 className="text-2xl font-semibold">AI assistant</h1>
        {status?.configured && (
          <span className="text-xs text-muted">
            {status.remaining} of {status.limit} questions left today
          </span>
        )}
      </div>
      <p className="mt-1 text-sm text-muted">
        Ask about gold prices, strategies, your backtests, your trade log or the news. It looks up every number on this
        site rather than guessing. It explains; it never tells you to buy or sell.
      </p>

      {status && !status.configured ? (
        <p className="mt-6 rounded-lg border border-border bg-surface p-4 text-sm text-muted">
          The assistant isn&apos;t switched on yet. It needs an Anthropic API key on the server.
        </p>
      ) : (
        <>
          <div className="mt-6 space-y-4">
            {msgs.length === 0 && (
              <div className="grid gap-2 sm:grid-cols-2">
                {SUGGESTIONS.map((s) => (
                  <button key={s} onClick={() => send(s)} disabled={waiting || status?.remaining === 0}
                          className="rounded-lg border border-border bg-surface p-3 text-left text-sm hover:border-gold disabled:opacity-50">
                    {s}
                  </button>
                ))}
              </div>
            )}
            {msgs.map((m, i) =>
              m.role === "user" ? (
                <div key={i} className="ml-auto max-w-[85%] rounded-lg bg-gold/15 px-3 py-2 text-sm">{m.content}</div>
              ) : (
                <div key={i} className={`max-w-[95%] rounded-lg border px-3 py-1 text-sm ${m.failed ? "border-down/50" : "border-border bg-surface"}`}>
                  <Rich text={m.content} />
                  {m.tools && m.tools.length > 0 && (
                    <p className="mb-2 text-xs text-muted">
                      Checked: {[...new Set(m.tools.map((t) => TOOL_LABELS[t] ?? t))].join(", ")}
                    </p>
                  )}
                </div>
              ),
            )}
            {waiting && (
              <div className="w-fit animate-pulse rounded-lg border border-border bg-surface px-3 py-2 text-sm text-muted">
                Looking that up…
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
              className="min-w-0 flex-1 resize-none rounded-md border border-border bg-background px-3 py-2 text-base outline-none focus:border-gold sm:text-sm"
            />
            <div className="flex flex-col gap-2">
              <button type="submit" disabled={waiting || !q.trim() || status?.remaining === 0}
                      className="rounded-md bg-gold px-4 py-2 text-sm font-medium text-black disabled:opacity-50">
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
