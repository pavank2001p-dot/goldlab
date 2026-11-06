"use client";

import { useEffect, useState } from "react";
import { Icon } from "./ui";

export type ShareStat = { label: string; value: string; tone?: "up" | "down" };
export type ShareInput = { kind: string; title: string; subtitle: string; stats: ShareStat[]; equity: number[] };

const W = 1200, H = 630;

/** Draws the result as a 1200 × 630 image (the size social sites preview) in the current accent colour. */
async function render(d: ShareInput): Promise<HTMLCanvasElement> {
  const css = getComputedStyle(document.documentElement);
  const accent = css.getPropertyValue("--gold").trim() || "#e8b53e";
  const hi = css.getPropertyValue("--gold-hi").trim() || "#f2c95a";
  const up = "#26b89a", down = "#ef5a55";
  await document.fonts?.ready;
  const font = getComputedStyle(document.body).fontFamily || "sans-serif";

  const cv = document.createElement("canvas");
  cv.width = W;
  cv.height = H;
  const g = cv.getContext("2d")!;
  // Deep charcoal with a glow of the accent in the corner.
  g.fillStyle = "#0b0e12";
  g.fillRect(0, 0, W, H);
  const glow = g.createRadialGradient(W - 120, 40, 10, W - 120, 40, 620);
  glow.addColorStop(0, accent + "40");
  glow.addColorStop(1, "transparent");
  g.fillStyle = glow;
  g.fillRect(0, 0, W, H);
  g.strokeStyle = "rgba(255,255,255,0.035)";
  g.lineWidth = 1;
  for (let x = 0; x < W; x += 48) { g.beginPath(); g.moveTo(x + 0.5, 0); g.lineTo(x + 0.5, H); g.stroke(); }
  for (let y = 0; y < H; y += 48) { g.beginPath(); g.moveTo(0, y + 0.5); g.lineTo(W, y + 0.5); g.stroke(); }
  g.strokeStyle = "rgba(255,255,255,0.08)";
  g.strokeRect(24.5, 24.5, W - 49, H - 49);

  // Brand.
  g.save();
  g.translate(78, 84);
  g.rotate(Math.PI / 4);
  const dg = g.createLinearGradient(-10, -10, 10, 10);
  dg.addColorStop(0, hi);
  dg.addColorStop(1, accent);
  g.fillStyle = dg;
  g.fillRect(-9, -9, 18, 18);
  g.restore();
  g.fillStyle = "#eef0f3";
  g.font = `600 26px ${font}`;
  g.textBaseline = "middle";
  g.fillText("GoldLab", 102, 85);
  g.textAlign = "right";
  g.fillStyle = accent;
  g.font = `600 18px ${font}`;
  g.fillText(d.kind.toUpperCase(), W - 64, 85);
  g.textAlign = "left";

  // Title, shrunk to fit.
  let size = 58;
  g.font = `700 ${size}px ${font}`;
  while (g.measureText(d.title).width > W - 140 && size > 30) g.font = `700 ${(size -= 2)}px ${font}`;
  g.fillStyle = "#ffffff";
  g.fillText(d.title, 64, 170);
  g.fillStyle = "#8f99a5";
  g.font = `400 22px ${font}`;
  g.fillText(d.subtitle, 64, 222);

  // Equity curve.
  const pts = d.equity.length > 1 ? d.equity : [1, 1];
  const top = 262, bottom = 448, left = 64, right = W - 64;
  const lo = Math.min(...pts), span = Math.max(...pts) - lo || 1;
  const xy = (v: number, i: number) => [left + (i / (pts.length - 1)) * (right - left), bottom - ((v - lo) / span) * (bottom - top)] as const;
  const fill = g.createLinearGradient(0, top, 0, bottom);
  fill.addColorStop(0, accent + "55");
  fill.addColorStop(1, accent + "00");
  g.beginPath();
  pts.forEach((v, i) => { const [x, y] = xy(v, i); if (i) g.lineTo(x, y); else g.moveTo(x, y); });
  g.lineTo(right, bottom);
  g.lineTo(left, bottom);
  g.closePath();
  g.fillStyle = fill;
  g.fill();
  g.beginPath();
  pts.forEach((v, i) => { const [x, y] = xy(v, i); if (i) g.lineTo(x, y); else g.moveTo(x, y); });
  g.strokeStyle = accent;
  g.lineWidth = 3;
  g.lineJoin = "round";
  g.shadowColor = accent;
  g.shadowBlur = 16;
  g.stroke();
  g.shadowBlur = 0;

  // Stats.
  const n = d.stats.length, gap = 16, bw = (W - 128 - gap * (n - 1)) / n;
  d.stats.forEach((s, i) => {
    const x = 64 + i * (bw + gap), y = 474;
    g.fillStyle = "rgba(255,255,255,0.04)";
    g.strokeStyle = "rgba(255,255,255,0.09)";
    g.beginPath();
    g.roundRect(x, y, bw, 88, 14);
    g.fill();
    g.stroke();
    g.fillStyle = "#8f99a5";
    g.font = `600 14px ${font}`;
    g.fillText(s.label.toUpperCase(), x + 18, y + 26);
    g.fillStyle = s.tone === "up" ? up : s.tone === "down" ? down : "#eef0f3";
    g.font = `700 32px ${font}`;
    g.fillText(s.value, x + 18, y + 60);
  });

  g.fillStyle = "#6b7480";
  g.font = `400 15px ${font}`;
  g.fillText("Simulated on past gold prices with costs. Past results don't predict future ones. Education only, not advice.", 64, 592);
  return cv;
}

/** A button that turns a result into a shareable image, with a preview, download and share. */
export default function ShareButton({ data, className = "" }: { data: ShareInput; className?: string }) {
  const [snap, setSnap] = useState<ShareInput | null>(null); // the result as it was when opened
  const open = snap != null;
  const setOpen = (on: boolean) => setSnap(on ? data : null);
  const [url, setUrl] = useState<string | null>(null);
  const [blob, setBlob] = useState<Blob | null>(null);
  const [note, setNote] = useState<string | null>(null);

  useEffect(() => {
    if (!snap) return;
    let gone = false;
    setNote(null);
    setUrl(null);
    render(snap).then((cv) => cv.toBlob((b) => {
      if (gone || !b) return;
      setBlob(b);
      setUrl(URL.createObjectURL(b));
    }, "image/png"));
    const key = (e: KeyboardEvent) => e.key === "Escape" && setSnap(null);
    window.addEventListener("keydown", key);
    return () => {
      gone = true;
      window.removeEventListener("keydown", key);
    };
  }, [snap]);
  useEffect(() => () => { if (url) URL.revokeObjectURL(url); }, [url]);

  const name = `goldlab-${data.title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "result"}.png`;
  const file = blob ? new File([blob], name, { type: "image/png" }) : null;
  const canShare = !!file && typeof navigator !== "undefined" && !!navigator.canShare?.({ files: [file] });

  async function copy() {
    try {
      await navigator.clipboard.write([new ClipboardItem({ "image/png": blob! })]);
      setNote("Copied. Paste it anywhere.");
    } catch {
      setNote("Your browser won't copy images. Use Download instead.");
    }
  }

  return (
    <>
      <button type="button" onClick={() => setOpen(true)}
        className={`flex items-center gap-1.5 rounded-full border border-border px-3 py-1.5 text-sm transition-colors hover:border-gold/60 hover:text-gold ${className}`}>
        <Icon name="upload" className="h-4 w-4" /> Share image
      </button>
      {open && (
        <div className="fan-in fixed inset-0 z-[65] flex items-center justify-center bg-black/70 p-4 backdrop-blur-sm" onClick={() => setOpen(false)}>
          <div role="dialog" aria-modal="true" aria-label="Share image" onClick={(e) => e.stopPropagation()}
            className="rise-in w-full max-w-3xl rounded-3xl border border-border bg-surface p-4 shadow-2xl sm:p-6">
            <div className="flex items-center justify-between gap-3">
              <h2 className="font-semibold">Share this result</h2>
              <button type="button" onClick={() => setOpen(false)} aria-label="Close" className="text-muted hover:text-foreground">
                <svg viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden><path d="M6 6l12 12M18 6 6 18" /></svg>
              </button>
            </div>
            <div className="mt-4 overflow-hidden rounded-2xl border border-border bg-background" style={{ aspectRatio: `${W} / ${H}` }}>
              {url ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={url} alt={`${data.title}: ${data.stats.map((s) => `${s.label} ${s.value}`).join(", ")}`} className="fan-in h-full w-full" />
              ) : <div className="h-full w-full animate-pulse bg-surface-2" />}
            </div>
            <div className="mt-4 flex flex-wrap items-center gap-2">
              {url && (
                <a href={url} download={name}
                  className="rounded-full bg-gradient-to-b from-gold-hi to-gold px-5 py-2 text-sm font-semibold text-black">Download PNG</a>
              )}
              {canShare && (
                <button type="button" onClick={() => navigator.share({ files: [file!], title: data.title }).catch(() => {})}
                  className="rounded-full border border-border px-4 py-2 text-sm transition-colors hover:border-gold/60">Share…</button>
              )}
              {blob && typeof ClipboardItem !== "undefined" && (
                <button type="button" onClick={copy} className="rounded-full border border-border px-4 py-2 text-sm transition-colors hover:border-gold/60">Copy image</button>
              )}
              {note && <span className="text-sm text-muted">{note}</span>}
              <span className="ml-auto text-xs text-muted">Shows results only. No account details are included.</span>
            </div>
          </div>
        </div>
      )}
    </>
  );
}

/** The usual four numbers of a backtest-style result, sampled down to a light equity line. */
export function resultShare(kind: string, title: string, subtitle: string,
  s: { total_return_pct: number | null; max_drawdown_pct: number; win_rate_pct: number | null; trades: number },
  equity: { equity: number }[]): ShareInput {
  const step = Math.max(1, Math.floor(equity.length / 300));
  const ret = s.total_return_pct;
  return {
    kind, title, subtitle,
    equity: equity.filter((_, i) => i % step === 0 || i === equity.length - 1).map((p) => p.equity),
    stats: [
      { label: "Return", value: ret == null ? "–" : `${ret >= 0 ? "+" : ""}${ret.toFixed(1)}%`, tone: ret == null ? undefined : ret >= 0 ? "up" : "down" },
      { label: "Worst drop", value: `${s.max_drawdown_pct.toFixed(1)}%`, tone: "down" },
      { label: "Win rate", value: s.win_rate_pct == null ? "–" : `${s.win_rate_pct.toFixed(0)}%` },
      { label: "Trades", value: s.trades.toLocaleString("en-US") },
    ],
  };
}
