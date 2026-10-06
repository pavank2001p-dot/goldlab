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

  const input = "w-full rounded-md border border-border bg-background px-3 py-2 outline-none focus:border-gold";
  return (
    <div className="mx-auto max-w-sm px-4 py-14">
      <h1 className="text-2xl font-semibold">{signup ? "Create your free account" : "Welcome back"}</h1>
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
        <button disabled={busy} className="w-full rounded-md bg-gold py-2 font-medium text-black hover:opacity-90 disabled:opacity-60">
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
  );
}
