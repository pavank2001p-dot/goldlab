"use client";

import Link from "next/link";
import { useState } from "react";
import AuthShell, { authButton, authInput } from "@/components/AuthShell";
import { api } from "@/lib/api";

export default function ForgotPasswordPage() {
  const [sentTo, setSentTo] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const email = String(new FormData(e.currentTarget).get("email"));
    setBusy(true);
    setError(null);
    try {
      await api.forgotPassword(email);
      setSentTo(email);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong");
    }
    setBusy(false);
  }

  if (sentTo)
    return (
      <AuthShell title="Check your email">
        <p className="mt-3 text-sm leading-relaxed text-muted">
          If there&apos;s a GoldLab account for <span className="text-foreground">{sentTo}</span>, we&apos;ve sent it a link to
          choose a new password. The link works for an hour. Nothing there? Check your spam folder, or try again in a minute.
        </p>
        <Link href="/login" className="mt-6 inline-block text-sm text-gold">Back to log in</Link>
      </AuthShell>
    );

  return (
    <AuthShell title="Reset your password" intro="Enter your email and we'll send you a link to choose a new one.">
      <form onSubmit={onSubmit} className="mt-6 space-y-4">
        <label className="block text-sm">
          <span className="text-muted">Email</span>
          <input name="email" type="email" required autoComplete="email" className={`mt-1 ${authInput}`} />
        </label>
        {error && <p className="text-sm text-down">{error}</p>}
        <button disabled={busy} className={authButton}>{busy ? "Please wait…" : "Send reset link"}</button>
      </form>
      <p className="mt-4 text-sm text-muted">
        Remembered it? <Link href="/login" className="text-gold">Log in</Link>
      </p>
    </AuthShell>
  );
}
