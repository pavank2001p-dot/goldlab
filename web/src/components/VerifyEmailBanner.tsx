"use client";

import { useState } from "react";
import { api, type User } from "@/lib/api";

// Shown on the dashboard until the email is confirmed. Nothing is locked meanwhile; a confirmed
// address is what lets password reset reach the right person.
export default function VerifyEmailBanner({ user }: { user: User }) {
  const [note, setNote] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  if (user.email_verified) return null;

  async function resend() {
    setBusy(true);
    try {
      const r = await api.resendVerification();
      setNote(r.already_verified ? "Your email is already confirmed." : `Sent. Check ${user.email}.`);
    } catch (err) {
      setNote(err instanceof Error ? err.message : "Something went wrong");
    }
    setBusy(false);
  }

  return (
    <div className="mt-6 flex flex-wrap items-center justify-between gap-3 rounded-xl border border-gold/40 bg-gold/5 px-4 py-3 text-sm">
      <p>
        <span className="font-medium">Confirm your email.</span>{" "}
        <span className="text-muted">We sent a link to {user.email}. It lets you reset your password if you forget it.</span>
      </p>
      {note ? (
        <span className="text-muted">{note}</span>
      ) : (
        <button onClick={resend} disabled={busy} className="rounded-lg border border-border px-3 py-1.5 hover:border-gold disabled:opacity-60">
          {busy ? "Sending…" : "Send it again"}
        </button>
      )}
    </div>
  );
}
