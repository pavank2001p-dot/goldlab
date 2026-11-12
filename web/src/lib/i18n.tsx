"use client";

import { useEffect, useState } from "react";
import { CATALOGS } from "@/i18n";
import { KEYS } from "./themeScript";

/**
 * Translation in one place. The English text in the code is the key, so a string that has no
 * translation yet shows in English instead of breaking. To add a language, add a catalog file in
 * src/i18n and one line to LANGS below; `npm run i18n:check` lists any strings it is missing.
 */
export type Lang = { code: string; name: string; english: string; rtl?: boolean; draft?: boolean };

export const LANGS: Lang[] = [
  { code: "en", name: "English", english: "English" },
  // Drafted by AI from the English, waiting for a native speaker to check.
  { code: "hi", name: "हिन्दी", english: "Hindi", draft: true },
  { code: "ar", name: "العربية", english: "Arabic", rtl: true, draft: true },
];

const EVENT = "goldlab-lang";

export function readLang(): string {
  try {
    const l = localStorage.getItem(KEYS.lang);
    return LANGS.some((x) => x.code === l) ? l! : "en";
  } catch {
    return "en";
  }
}

export function setLang(code: string) {
  try { localStorage.setItem(KEYS.lang, code); } catch {}
  const l = LANGS.find((x) => x.code === code) ?? LANGS[0];
  document.documentElement.lang = l.code;
  document.documentElement.dir = l.rtl ? "rtl" : "ltr";
  window.dispatchEvent(new Event(EVENT));
}

/** Fill {name} placeholders. */
function fill(s: string, vars?: Record<string, string | number>) {
  return vars ? s.replace(/\{(\w+)\}/g, (m, k) => (k in vars ? String(vars[k]) : m)) : s;
}

/** Marks English text that is translated later through a variable, so `i18n:check` can find it. */
export const msg = (english: string) => english;

export type T = (english: string, vars?: Record<string, string | number>) => string;

/** The chosen language and a `t` that translates English text into it. */
export function useT(): { t: T; lang: string } {
  const [lang, setL] = useState("en");
  useEffect(() => {
    const sync = () => setL(readLang());
    sync();
    window.addEventListener(EVENT, sync);
    return () => window.removeEventListener(EVENT, sync);
  }, []);
  const cat = CATALOGS[lang];
  const t: T = (english, vars) => fill(cat?.[english] || english, vars);
  return { t, lang };
}
