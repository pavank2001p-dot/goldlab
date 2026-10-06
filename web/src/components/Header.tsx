"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { api } from "@/lib/api";
import { useUser } from "@/lib/useUser";

export default function Header() {
  const { user, setUser } = useUser();
  const router = useRouter();

  async function logout() {
    await api.logout();
    setUser(null);
    router.push("/");
    router.refresh();
  }

  return (
    <header className="border-b border-border">
      <div className="mx-auto flex max-w-6xl items-center gap-6 px-4 py-3">
        <Link href="/" className="flex items-center gap-2 font-semibold">
          <span className="inline-block h-3 w-3 rounded-sm bg-gold" />
          GoldLab
        </Link>
        <nav className="flex gap-4 text-sm text-muted">
          <Link href="/chart" className="hover:text-foreground">Chart</Link>
        </nav>
        <div className="ml-auto flex items-center gap-3 text-sm">
          {user === undefined ? null : user ? (
            <>
              <Link href="/account" className="text-muted hover:text-foreground">{user.name || user.email}</Link>
              <button onClick={logout} className="rounded-md border border-border px-3 py-1.5 hover:bg-surface">
                Log out
              </button>
            </>
          ) : (
            <>
              <Link href="/login" className="text-muted hover:text-foreground">Log in</Link>
              <Link href="/signup" className="rounded-md bg-gold px-3 py-1.5 font-medium text-black hover:opacity-90">
                Sign up free
              </Link>
            </>
          )}
        </div>
      </div>
    </header>
  );
}
