"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useState } from "react";
import AuthShell, { authButton, authInput } from "@/components/AuthShell";
import { api } from "@/lib/api";
import { useUser } from "@/lib/useUser";

function ResetForm() {
  const router = useRouter();
  const { setUser } = useUser();
  const token = useSearchParams().get("token") ?? "";
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  if (!token)
    return (
      <AuthShell title="Link incomplete">
        <p className="mt-3 text-sm text-muted">This page needs the link from your email. Open it again, or ask for a new one.</p>
        <Link href="/forgot-password" className="mt-6 inline-block text-sm text-gold">Send a new link</Link>
      </AuthShell>
    );

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const password = String(f.get("password"));
    if (password !== String(f.get("confirm"))) {
      setError("The two passwords don't match.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      setUser(await api.resetPassword(token, password));
      router.push("/account");
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong");
      setBusy(false);
    }
  }

  return (
    <AuthShell title="Choose a new password" intro="You'll be signed out everywhere else and signed in here.">
      <form onSubmit={onSubmit} className="mt-6 space-y-4">
        <label className="block text-sm">
          <span className="text-muted">New password (at least 8 characters)</span>
          <input name="password" type="password" required minLength={8} maxLength={128} autoComplete="new-password" className={`mt-1 ${authInput}`} />
        </label>
        <label className="block text-sm">
          <span className="text-muted">Type it again</span>
          <input name="confirm" type="password" required minLength={8} maxLength={128} autoComplete="new-password" className={`mt-1 ${authInput}`} />
        </label>
        {error && (
          <p className="text-sm text-down">
            {error}{" "}
            {error.includes("expired") && <Link href="/forgot-password" className="text-gold">Send a new link</Link>}
          </p>
        )}
        <button disabled={busy} className={authButton}>{busy ? "Please wait…" : "Save password"}</button>
      </form>
    </AuthShell>
  );
}

export default function ResetPasswordPage() {
  return (
    <Suspense>
      <ResetForm />
    </Suspense>
  );
}
