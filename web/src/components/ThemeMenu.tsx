"use client";

import { useEffect, useRef, useState } from "react";
import { ACCENTS, setAccent, setMode, useTheme, type Mode } from "@/lib/theme";

const MODES: { key: Mode; label: string; icon: React.ReactNode }[] = [
  { key: "dark", label: "Dark", icon: <path d="M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5Z" /> },
  { key: "light", label: "Light", icon: <><circle cx="12" cy="12" r="4" /><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" /></> },
  { key: "auto", label: "Auto", icon: <><rect x="3" y="4" width="18" height="13" rx="2" /><path d="M8 21h8M12 17v4" /></> },
];

function Glyph({ children, className = "h-4 w-4" }: { children: React.ReactNode; className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden>
      {children}
    </svg>
  );
}

/** Light, dark or follow the device, plus the accent colour used for highlights. */
export default function ThemeMenu() {
  const { mode, accent } = useTheme();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent | KeyboardEvent) => {
      if (e instanceof KeyboardEvent ? e.key === "Escape" : !ref.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", close);
    document.addEventListener("keydown", close);
    return () => {
      document.removeEventListener("mousedown", close);
      document.removeEventListener("keydown", close);
    };
  }, [open]);
  const current = MODES.find((m) => m.key === mode) ?? MODES[0];
  return (
    <div ref={ref} className="relative" data-tour="theme">
      <button type="button" onClick={() => setOpen(!open)} aria-expanded={open} aria-label="Appearance"
        className="flex h-8 w-8 items-center justify-center rounded-full border border-border text-muted transition-colors hover:text-foreground">
        <Glyph>{current.icon}</Glyph>
      </button>
      {open && (
        <div className="rise-in absolute right-0 top-full z-50 mt-2 w-64 rounded-2xl border border-border bg-surface p-3 shadow-2xl shadow-black/30">
          <p className="px-1 text-xs font-medium uppercase tracking-wider text-muted">Appearance</p>
          <div className="mt-2 grid grid-cols-3 gap-1 rounded-xl bg-background p-1">
            {MODES.map((m) => (
              <button key={m.key} type="button" onClick={() => setMode(m.key)} aria-pressed={mode === m.key}
                className={`flex flex-col items-center gap-1 rounded-lg py-2 text-xs transition-colors ${mode === m.key ? "bg-surface-2 text-foreground shadow-sm" : "text-muted hover:text-foreground"}`}>
                <Glyph>{m.icon}</Glyph>
                {m.label}
              </button>
            ))}
          </div>
          <p className="mt-4 px-1 text-xs font-medium uppercase tracking-wider text-muted">Accent</p>
          <div className="mt-2 grid grid-cols-4 gap-2">
            {ACCENTS.map((a) => (
              <button key={a.key} type="button" onClick={() => setAccent(a.key)} aria-pressed={accent === a.key} title={a.label}
                className="group flex flex-col items-center gap-1.5 text-[11px] text-muted">
                <span className={`h-8 w-8 rounded-full ring-2 ring-offset-2 ring-offset-surface transition ${accent === a.key ? "ring-foreground" : "ring-transparent group-hover:ring-border"}`}
                  style={{ background: `linear-gradient(135deg, ${a.swatch}, color-mix(in srgb, ${a.swatch} 55%, black))` }} />
                <span className={accent === a.key ? "text-foreground" : ""}>{a.label.split(" ")[0]}</span>
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
