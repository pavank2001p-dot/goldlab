"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useState } from "react";
import { api } from "@/lib/api";
import { useUser } from "@/lib/useUser";

export default function AuthForm({ mode }: { mode: "login" | "signup" }) {
  const router = useRouter();
  const { setUser } = useUser();
  const next = useSearchParams().get("next") || "/account";
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const signup = mode === "signup";

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const email = String(f.get("email"));
    const password = String(f.get("password"));
    setBusy(true);
    setError(null);
    try {
      setUser(signup ? await api.signup(email, password, String(f.get("name") ?? "")) : await api.login(email, password));
      // Only follow same-site paths.
      router.push(next.startsWith("/") && !next.startsWith("//") ? next : "/account");
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong");
      setBusy(false);
    }
  }

  const input = "w-full rounded-lg border border-border bg-background px-3 py-2 outline-none transition focus:border-gold focus:shadow-[0_0_0_3px_color-mix(in_srgb,var(--gold)_15%,transparent)]";
  return (
    <div className="relative mx-auto max-w-sm px-4 py-14">
      <div aria-hidden className="pointer-events-none absolute left-1/2 top-6 h-40 w-72 -translate-x-1/2 rounded-full bg-gold/10 blur-3xl" />
      <div className="relative rounded-2xl border border-border bg-surface p-6">
      <span className="flex h-10 w-10 items-center justify-center rounded-2xl bg-gradient-to-br from-gold to-gold-deep">
        <span className="h-3 w-3 rotate-45 rounded-[3px] bg-black/80" />
      </span>
      <h1 className="mt-4 text-2xl font-semibold">{signup ? "Create your free account" : "Welcome back"}</h1>
      <p className="mt-1 text-sm text-muted">{signup ? "Save your backtests, trades and risk profile." : "Log in to pick up where you left off."}</p>
      <form onSubmit={onSubmit} className="mt-6 space-y-4">
        {signup && (
          <label className="block text-sm">
            <span className="text-muted">Name</span>
            <input name="name" autoComplete="name" maxLength={80} className={`mt-1 ${input}`} />
          </label>
        )}
        <label className="block text-sm">
          <span className="text-muted">Email</span>
          <input name="email" type="email" required autoComplete="email" className={`mt-1 ${input}`} />
        </label>
        <label className="block text-sm">
          <span className="text-muted">Password{signup && " (at least 8 characters)"}</span>
          <input
            name="password"
            type="password"
            required
            minLength={signup ? 8 : undefined}
            autoComplete={signup ? "new-password" : "current-password"}
            className={`mt-1 ${input}`}
          />
        </label>
        {error && <p className="text-sm text-down">{error}</p>}
        <button disabled={busy} className="w-full rounded-lg bg-gold py-2 font-medium text-black hover:opacity-90 disabled:opacity-60">
          {busy ? "Please wait…" : signup ? "Sign up" : "Log in"}
        </button>
      </form>
      <p className="mt-4 text-sm text-muted">
        {signup ? (
          <>Already have an account? <Link href="/login" className="text-gold">Log in</Link></>
        ) : (
          <>New here? <Link href="/signup" className="text-gold">Create an account</Link></>
        )}
      </p>
      </div>
    </div>
  );
}
