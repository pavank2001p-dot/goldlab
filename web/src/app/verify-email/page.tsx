"use client";

import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { Suspense, useEffect, useRef, useState } from "react";
import AuthShell from "@/components/AuthShell";
import { api } from "@/lib/api";
import { useUser } from "@/lib/useUser";

function Verify() {
  const token = useSearchParams().get("token") ?? "";
  const { user, setUser } = useUser();
  const [state, setState] = useState<{ ok: boolean; message: string } | null>(
    token ? null : { ok: false, message: "This page needs the link from your email." },
  );
  const started = useRef(false);

  useEffect(() => {
    // Links work once, so don't send the token twice (React runs effects twice in development).
    if (!token || started.current) return;
    started.current = true;
    api.verifyEmail(token).then(
      (r) => setState({ ok: true, message: `${r.email} is confirmed. Thanks!` }),
      (err) => setState({ ok: false, message: err instanceof Error ? err.message : "Something went wrong" }),
    );
  }, [token]);

  useEffect(() => {
    if (state?.ok && user && !user.email_verified) setUser({ ...user, email_verified: true });
  }, [state, user, setUser]);

  return (
    <AuthShell title={state === null ? "Confirming your email…" : state.ok ? "Email confirmed" : "Couldn't confirm"}>
      {state && <p className={`mt-3 text-sm ${state.ok ? "text-muted" : "text-down"}`}>{state.message}</p>}
      {state && (
        <Link href={user ? "/account" : "/login"} className="mt-6 inline-block text-sm text-gold">
          {user ? "Go to your dashboard" : "Log in"}
        </Link>
      )}
    </AuthShell>
  );
}

export default function VerifyEmailPage() {
  return (
    <Suspense>
      <Verify />
    </Suspense>
  );
}
