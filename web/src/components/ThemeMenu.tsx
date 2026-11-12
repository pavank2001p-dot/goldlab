"use client";

import { useEffect, useRef, useState } from "react";
import { ACCENTS, setAccent, setMode, useTheme, type Mode } from "@/lib/theme";
import { LANGS, msg, setLang, useT } from "@/lib/i18n";
import { CURRENCIES, UNITS, UNIT_NAMES, setLocal, useLocalPrice } from "@/lib/localPrice";

const MODES: { key: Mode; label: string; icon: React.ReactNode }[] = [
  { key: "dark", label: msg("Dark"), icon: <path d="M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5Z" /> },
  { key: "light", label: msg("Light"), icon: <><circle cx="12" cy="12" r="4" /><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" /></> },
  { key: "auto", label: msg("Auto"), icon: <><rect x="3" y="4" width="18" height="13" rx="2" /><path d="M8 21h8M12 17v4" /></> },
];

function Glyph({ children, className = "h-4 w-4" }: { children: React.ReactNode; className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden>
      {children}
    </svg>
  );
}

const ACCENT_NAMES: Record<string, string> = { gold: msg("Gold"), rose: msg("Rose"), platinum: msg("Platinum"), sapphire: msg("Sapphire") };

const label = "px-1 text-xs font-medium uppercase tracking-wider text-muted";
const select = "mt-2 w-full rounded-lg border border-border bg-background px-2 py-1.5 text-sm text-foreground";

/** Light, dark or follow the device, plus the accent colour used for highlights. */
export default function ThemeMenu() {
  const { mode, accent } = useTheme();
  const { t, lang } = useT();
  const { pref } = useLocalPrice();
  const draft = LANGS.find((l) => l.code === lang)?.draft;
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
      <button type="button" onClick={() => setOpen(!open)} aria-expanded={open} aria-label={t("Settings")} title={t("Settings")}
        className="flex h-8 w-8 items-center justify-center rounded-full border border-border text-muted transition-colors hover:text-foreground">
        <Glyph>{current.icon}</Glyph>
      </button>
      {open && (
        <div className="rise-in absolute end-0 top-full z-50 mt-2 max-h-[calc(100dvh-80px)] w-72 overflow-y-auto rounded-2xl border border-border bg-surface p-3 shadow-2xl shadow-black/30">
          <p className={label}>{t("Appearance")}</p>
          <div className="mt-2 grid grid-cols-3 gap-1 rounded-xl bg-background p-1">
            {MODES.map((m) => (
              <button key={m.key} type="button" onClick={() => setMode(m.key)} aria-pressed={mode === m.key}
                className={`flex flex-col items-center gap-1 rounded-lg py-2 text-xs transition-colors ${mode === m.key ? "bg-surface-2 text-foreground shadow-sm" : "text-muted hover:text-foreground"}`}>
                <Glyph>{m.icon}</Glyph>
                {t(m.label)}
              </button>
            ))}
          </div>
          <p className={`mt-4 ${label}`}>{t("Accent")}</p>
          <div className="mt-2 grid grid-cols-4 gap-2">
            {ACCENTS.map((a) => (
              <button key={a.key} type="button" onClick={() => setAccent(a.key)} aria-pressed={accent === a.key} title={t(ACCENT_NAMES[a.key] ?? a.label)}
                className="group flex flex-col items-center gap-1.5 text-[11px] text-muted">
                <span className={`h-8 w-8 rounded-full ring-2 ring-offset-2 ring-offset-surface transition ${accent === a.key ? "ring-foreground" : "ring-transparent group-hover:ring-border"}`}
                  style={{ background: `linear-gradient(135deg, ${a.swatch}, color-mix(in srgb, ${a.swatch} 55%, black))` }} />
                <span className={accent === a.key ? "text-foreground" : ""}>{t(ACCENT_NAMES[a.key] ?? a.label)}</span>
              </button>
            ))}
          </div>
          <label htmlFor="lang-pick" className={`mt-4 block ${label}`}>{t("Language")}</label>
          <select id="lang-pick" value={lang} onChange={(e) => setLang(e.target.value)} className={select}>
            {LANGS.map((l) => (
              <option key={l.code} value={l.code}>{l.code === "en" ? l.name : `${l.name} (${l.english})`}</option>
            ))}
          </select>
          {draft && <p className="mt-1.5 px-1 text-[11px] leading-snug text-muted">{t("Draft translation: a native speaker hasn't checked it yet.")}</p>}
          <p className={`mt-4 ${label}`}>{t("Local gold price")}</p>
          <div className="mt-2 grid grid-cols-2 gap-2">
            <label className="text-[11px] text-muted">
              {t("Currency")}
              <select value={pref.currency} onChange={(e) => setLocal({ currency: e.target.value })} className={`!mt-1 ${select}`}>
                {CURRENCIES.map((c) => <option key={c.code} value={c.code} title={c.name}>{c.code}</option>)}
              </select>
            </label>
            <label className="text-[11px] text-muted">
              {t("Unit")}
              <select value={pref.unit} onChange={(e) => setLocal({ unit: e.target.value as typeof pref.unit })} className={`!mt-1 ${select}`}>
                {UNITS.map((u) => <option key={u.key} value={u.key}>{t(UNIT_NAMES[u.key])}</option>)}
              </select>
            </label>
          </div>
          <p className="mt-1.5 px-1 text-[11px] leading-snug text-muted">{t("Trading stays in US dollars per ounce.")}</p>
        </div>
      )}
    </div>
  );
}
