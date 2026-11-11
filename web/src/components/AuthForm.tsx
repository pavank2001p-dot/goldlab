"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useEffect, useState } from "react";
import AuthShell, { authButton, authInput } from "@/components/AuthShell";
import { api } from "@/lib/api";
import { useUser } from "@/lib/useUser";

const GOOGLE_ERRORS: Record<string, string> = {
  google_cancelled: "Google sign-in was cancelled.",
  google_expired: "That Google sign-in took too long or was opened in another browser. Please try again.",
  google_failed: "Google sign-in didn't work this time. Please try again.",
  google_unverified: "We couldn't use that Google account. Its email isn't confirmed with Google, or it's already linked to another GoldLab account.",
};

function GoogleLogo() {
  return (
    <svg viewBox="0 0 48 48" className="h-4 w-4" aria-hidden>
      <path fill="#FFC107" d="M43.6 20.5H42V20H24v8h11.3C33.7 32.7 29.2 36 24 36c-6.6 0-12-5.4-12-12s5.4-12 12-12c3.1 0 5.8 1.2 7.9 3.1l5.7-5.7C34 6.1 29.3 4 24 4 12.9 4 4 12.9 4 24s8.9 20 20 20 20-8.9 20-20c0-1.3-.1-2.4-.4-3.5z" />
      <path fill="#FF3D00" d="M6.3 14.7l6.6 4.8C14.7 15.1 19 12 24 12c3.1 0 5.8 1.2 7.9 3.1l5.7-5.7C34 6.1 29.3 4 24 4 16.3 4 9.7 8.3 6.3 14.7z" />
      <path fill="#4CAF50" d="M24 44c5.2 0 9.9-2 13.4-5.2l-6.2-5.2C29.2 35.1 26.7 36 24 36c-5.2 0-9.6-3.3-11.3-8l-6.5 5C9.5 39.6 16.2 44 24 44z" />
      <path fill="#1976D2" d="M43.6 20.5H42V20H24v8h11.3c-.8 2.2-2.2 4.2-4.1 5.6l6.2 5.2C37 39.2 44 34 44 24c0-1.3-.1-2.4-.4-3.5z" />
    </svg>
  );
}

export default function AuthForm({ mode }: { mode: "login" | "signup" }) {
  const router = useRouter();
  const { setUser } = useUser();
  const params = useSearchParams();
  const rawNext = params.get("next") || "/account";
  // Only follow same-site paths.
  const next = rawNext.startsWith("/") && !rawNext.startsWith("//") ? rawNext : "/account";
  const [error, setError] = useState<string | null>(GOOGLE_ERRORS[params.get("error") ?? ""] ?? null);
  const [busy, setBusy] = useState(false);
  const [google, setGoogle] = useState(false);
  const signup = mode === "signup";

  useEffect(() => {
    api.authConfig().then((c) => setGoogle(c.google), () => {});
  }, []);

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const email = String(f.get("email"));
    const password = String(f.get("password"));
    setBusy(true);
    setError(null);
    try {
      setUser(signup ? await api.signup(email, password, String(f.get("name") ?? "")) : await api.login(email, password));
      router.push(next);
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong");
      setBusy(false);
    }
  }

  return (
    <AuthShell
      title={signup ? "Create your free account" : "Welcome back"}
      intro={signup ? "Save your backtests, trades and risk profile." : "Log in to pick up where you left off."}
    >
      {google && (
        <>
          <a
            href={`/api/auth/google/start?next=${encodeURIComponent(next)}`}
            className="mt-6 flex w-full items-center justify-center gap-2 rounded-lg border border-border bg-background py-2 font-medium transition hover:border-gold"
          >
            <GoogleLogo />
            Continue with Google
          </a>
          <div className="mt-5 flex items-center gap-3 text-xs text-muted">
            <span className="h-px flex-1 bg-border" />
            or with email
            <span className="h-px flex-1 bg-border" />
          </div>
        </>
      )}
      <form onSubmit={onSubmit} className={`${google ? "mt-5" : "mt-6"} space-y-4`}>
        {signup && (
          <label className="block text-sm">
            <span className="text-muted">Name</span>
            <input name="name" autoComplete="name" maxLength={80} className={`mt-1 ${authInput}`} />
          </label>
        )}
        <label className="block text-sm">
          <span className="text-muted">Email</span>
          <input name="email" type="email" required autoComplete="email" className={`mt-1 ${authInput}`} />
        </label>
        <label className="block text-sm">
          <span className="flex items-baseline justify-between">
            <span className="text-muted">Password{signup && " (at least 8 characters)"}</span>
            {!signup && (
              <Link href="/forgot-password" className="text-xs text-gold">
                Forgot password?
              </Link>
            )}
          </span>
          <input
            name="password"
            type="password"
            required
            minLength={signup ? 8 : undefined}
            autoComplete={signup ? "new-password" : "current-password"}
            className={`mt-1 ${authInput}`}
          />
        </label>
        {error && <p className="text-sm text-down">{error}</p>}
        <button disabled={busy} className={authButton}>
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
    </AuthShell>
  );
}
