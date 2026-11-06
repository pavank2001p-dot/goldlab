"use client";

import { useEffect } from "react";
import { api, fmtPrice } from "@/lib/api";
import { useUser } from "@/lib/useUser";
import { toast } from "../Toaster";

export const ALERTS_EVENT = "goldlab-alerts";
const EVERY_MS = 30_000;

/** Checks the signed-in user's price alerts while any page is open, with a toast and, if allowed, a browser notification. */
export default function AlertWatcher() {
  const { user } = useUser();
  useEffect(() => {
    if (!user) return;
    const check = () => {
      if (document.visibilityState !== "visible" && !("Notification" in window && Notification.permission === "granted")) return;
      api.checkAlerts().then(({ triggered }) => {
        if (!triggered.length) return;
        for (const a of triggered) {
          const title = `Gold ${a.direction === "above" ? "rose to" : "fell to"} ${fmtPrice(a.price)}`;
          const body = a.note || `Your alert was reached${a.triggered_price ? `; the price is now ${fmtPrice(a.triggered_price)}` : ""}.`;
          toast(title, { body, tone: a.direction === "above" ? "up" : "down" });
          try {
            if ("Notification" in window && Notification.permission === "granted") new Notification(title, { body, tag: `goldlab-alert-${a.id}` });
          } catch {}
        }
        window.dispatchEvent(new Event(ALERTS_EVENT));
      }, () => {});
    };
    check();
    const t = setInterval(check, EVERY_MS);
    return () => clearInterval(t);
  }, [user]);
  return null;
}
