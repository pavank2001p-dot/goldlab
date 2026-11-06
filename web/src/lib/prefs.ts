"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "./api";
import { useUser } from "./useUser";

type Key = "drawings" | "indicators" | "chart_events";

// One fetch of the account's settings per signed-in user per page load.
let cache: { user: number; prefs: Promise<Record<string, unknown>> } | null = null;
function serverPrefs(user: number) {
  if (cache?.user !== user) cache = { user, prefs: api.prefs().catch(() => ({})) };
  return cache.prefs;
}
const timers: Partial<Record<Key, ReturnType<typeof setTimeout>>> = {};

function readLocal<T>(local: string, fallback: T): T {
  try {
    const v = localStorage.getItem(local);
    return v == null ? fallback : (JSON.parse(v) as T);
  } catch { return fallback; }
}

/** A setting kept in this browser and, when signed in, in the account, so it follows the user to other devices.
 *  The account's copy wins when both exist; a browser-only copy is uploaded the first time they sign in. */
export function usePref<T>(key: Key, local: string, fallback: T, enabled = true): [T, (v: T) => void, boolean] {
  const { user } = useUser();
  const [value, setValue] = useState<T>(fallback);
  const [loaded, setLoaded] = useState(false);
  const fb = useRef(fallback);

  useEffect(() => {
    if (!enabled || user === undefined) return;
    const mine = readLocal(local, fb.current);
    setValue(mine);
    if (!user) { setLoaded(true); return; }
    let live = true;
    serverPrefs(user.id).then((all) => {
      if (!live) return;
      if (key in all) {
        const v = all[key] as T;
        setValue(v);
        try { localStorage.setItem(local, JSON.stringify(v)); } catch {}
      } else if (JSON.stringify(mine) !== JSON.stringify(fb.current)) {
        api.setPref(key, mine).catch(() => {});
      }
      setLoaded(true);
    });
    return () => { live = false; };
  }, [key, local, enabled, user]);

  const set = useCallback((v: T) => {
    setValue(v);
    try { localStorage.setItem(local, JSON.stringify(v)); } catch {}
    if (user) {
      cache?.prefs.then((all) => { all[key] = v; });
      clearTimeout(timers[key]);
      timers[key] = setTimeout(() => api.setPref(key, v).catch(() => {}), 800);
    }
  }, [key, local, user]);

  return [value, set, loaded];
}
