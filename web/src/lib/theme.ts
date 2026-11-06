"use client";

import { useEffect, useState } from "react";
import { KEYS } from "./themeScript";

export type Mode = "dark" | "light" | "auto";
export type Accent = "gold" | "rose" | "platinum" | "sapphire";

export const ACCENTS: { key: Accent; label: string; swatch: string }[] = [
  { key: "gold", label: "Gold", swatch: "#e8b53e" },
  { key: "rose", label: "Rose gold", swatch: "#e59a84" },
  { key: "platinum", label: "Platinum", swatch: "#b7c3d0" },
  { key: "sapphire", label: "Sapphire", swatch: "#6fa8ff" },
];

const EVENT = "goldlab-theme";

function read<T extends string>(key: string, fallback: T): T {
  try {
    return (localStorage.getItem(key) as T) || fallback;
  } catch {
    return fallback;
  }
}

function apply() {
  const d = document.documentElement;
  const mode = read<Mode>(KEYS.mode, "dark");
  d.dataset.theme = mode === "auto" ? (matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark") : mode;
  d.dataset.accent = read<Accent>(KEYS.accent, "gold");
  window.dispatchEvent(new Event(EVENT));
}

export function setMode(m: Mode) {
  try { localStorage.setItem(KEYS.mode, m); } catch {}
  apply();
}

export function setAccent(a: Accent) {
  try { localStorage.setItem(KEYS.accent, a); } catch {}
  apply();
}

/** The saved choices, kept in step with changes made anywhere on the page. */
export function useTheme() {
  const [s, setS] = useState<{ mode: Mode; accent: Accent; key: number }>({ mode: "dark", accent: "gold", key: 0 });
  useEffect(() => {
    const sync = (bump = true) =>
      setS((p) => ({ mode: read<Mode>(KEYS.mode, "dark"), accent: read<Accent>(KEYS.accent, "gold"), key: p.key + (bump ? 1 : 0) }));
    sync(false);
    const onChange = () => sync();
    const mq = matchMedia("(prefers-color-scheme: light)");
    const onSystem = () => read<Mode>(KEYS.mode, "dark") === "auto" && apply();
    window.addEventListener(EVENT, onChange);
    mq.addEventListener("change", onSystem);
    return () => {
      window.removeEventListener(EVENT, onChange);
      mq.removeEventListener("change", onSystem);
    };
  }, []);
  return s;
}

/** A number that changes whenever the colours do: put it in a chart's effect dependencies to redraw it. */
export function useThemeKey() {
  return useTheme().key;
}

/** A theme colour as rgba, for chart libraries that can't read CSS variables. */
export function alpha(color: string, a: number) {
  const h = color.replace("#", "");
  if (!/^[0-9a-f]{6}$/i.test(h)) return color;
  const n = parseInt(h, 16);
  return `rgba(${n >> 16},${(n >> 8) & 255},${n & 255},${a})`;
}
