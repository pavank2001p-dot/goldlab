"use client";

import { useEffect, useState } from "react";
import { api, type FxRates } from "./api";
import { msg } from "./i18n";
import { KEYS } from "./themeScript";

/** Gold units people quote locally, in grams. A troy ounce is what XAU/USD is priced in. */
export const UNITS = [
  { key: "oz", label: "troy ounce", short: "oz", grams: 31.1034768 },
  { key: "g", label: "gram", short: "g", grams: 1 },
  { key: "10g", label: "10 grams", short: "10 g", grams: 10 },
  { key: "tola", label: "tola", short: "tola", grams: 11.6638038 },
  { key: "kg", label: "kilogram", short: "kg", grams: 1000 },
] as const;
export type Unit = (typeof UNITS)[number]["key"];
export const UNIT_NAMES: Record<Unit, string> = { oz: msg("troy ounce"), g: msg("gram"), "10g": msg("10 grams"), tola: msg("tola"), kg: msg("kilogram") };

export const CURRENCIES: { code: string; name: string; unit: Unit }[] = [
  { code: "USD", name: "US dollar", unit: "oz" },
  { code: "INR", name: "Indian rupee", unit: "10g" },
  { code: "AED", name: "UAE dirham", unit: "g" },
  { code: "SAR", name: "Saudi riyal", unit: "g" },
  { code: "PKR", name: "Pakistani rupee", unit: "tola" },
  { code: "EUR", name: "Euro", unit: "g" },
  { code: "GBP", name: "British pound", unit: "g" },
  { code: "SGD", name: "Singapore dollar", unit: "g" },
  { code: "MYR", name: "Malaysian ringgit", unit: "g" },
  { code: "AUD", name: "Australian dollar", unit: "oz" },
  { code: "CAD", name: "Canadian dollar", unit: "oz" },
  { code: "JPY", name: "Japanese yen", unit: "g" },
  { code: "CNY", name: "Chinese yuan", unit: "g" },
  { code: "TRY", name: "Turkish lira", unit: "g" },
  { code: "ZAR", name: "South African rand", unit: "oz" },
];

export type LocalPref = { currency: string; unit: Unit };
const DEFAULT: LocalPref = { currency: "USD", unit: "oz" };
const EVENT = "goldlab-local";

export function readLocal(): LocalPref {
  try {
    const v = JSON.parse(localStorage.getItem(KEYS.local) || "null");
    if (v && CURRENCIES.some((c) => c.code === v.currency) && UNITS.some((u) => u.key === v.unit)) return v;
  } catch {}
  return DEFAULT;
}

export function setLocal(p: Partial<LocalPref>) {
  const cur = readLocal();
  // Picking a currency also picks the unit people usually quote it in; the unit can still be changed.
  const next = { ...cur, ...p };
  if (p.currency && !p.unit) next.unit = CURRENCIES.find((c) => c.code === p.currency)?.unit ?? cur.unit;
  try { localStorage.setItem(KEYS.local, JSON.stringify(next)); } catch {}
  window.dispatchEvent(new Event(EVENT));
}

let fxPromise: Promise<FxRates> | null = null;
function loadFx() {
  fxPromise ??= api.fx().catch((e) => {
    fxPromise = null;
    throw e;
  });
  return fxPromise;
}

/** Convert a dollars-per-ounce price into the chosen currency and unit. */
export function convert(usdPerOz: number, pref: LocalPref, fx: FxRates | null): number | null {
  const rate = fx?.rates[pref.currency];
  const unit = UNITS.find((u) => u.key === pref.unit)!;
  if (rate == null) return null;
  return (usdPerOz / UNITS[0].grams) * unit.grams * rate;
}

export function fmtLocal(v: number, currency: string, lang = "en") {
  try {
    return new Intl.NumberFormat(lang === "en" ? undefined : lang, {
      style: "currency", currency, maximumFractionDigits: v >= 1000 ? 0 : 2,
    }).format(v);
  } catch {
    return `${currency} ${v.toFixed(2)}`;
  }
}

/** The saved currency and unit, plus exchange rates once the chosen currency isn't dollars. */
export function useLocalPrice() {
  const [pref, setPref] = useState<LocalPref>(DEFAULT);
  const [fx, setFx] = useState<FxRates | null>(null);
  useEffect(() => {
    const sync = () => setPref(readLocal());
    sync();
    window.addEventListener(EVENT, sync);
    return () => window.removeEventListener(EVENT, sync);
  }, []);
  const local = pref.currency !== "USD" || pref.unit !== "oz";
  useEffect(() => {
    if (local && !fx) loadFx().then(setFx, () => {});
  }, [local, fx]);
  return { pref, fx, local };
}
