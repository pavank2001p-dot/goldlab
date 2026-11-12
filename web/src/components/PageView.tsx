"use client";

import { usePathname } from "next/navigation";
import { useEffect, useRef } from "react";

/** Counts one view per page change: the path and where the visitor came from, nothing that identifies them. */
export default function PageView() {
  const path = usePathname();
  const first = useRef(true);
  useEffect(() => {
    if (navigator.doNotTrack === "1") return;
    // Only the first page of a visit has an outside referrer; later pages count as moving around the site.
    const referrer = first.current ? document.referrer : location.href;
    first.current = false;
    const body = JSON.stringify({ path, referrer, host: location.host });
    try {
      if (!navigator.sendBeacon?.("/api/analytics/view", new Blob([body], { type: "application/json" })))
        fetch("/api/analytics/view", { method: "POST", body, headers: { "Content-Type": "application/json" }, keepalive: true }).catch(() => {});
    } catch {}
  }, [path]);
  return null;
}
