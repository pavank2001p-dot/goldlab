"use client";

import { useUser } from "@/lib/useUser";
import Dashboard from "./Dashboard";

/** Signed in: the live desk. Signed out (or still checking): the welcome hero, hidden until we know. */
export default function HomeTop({ hero }: { hero: React.ReactNode }) {
  const { user } = useUser();
  if (user) return <Dashboard user={user} />;
  return <div className={user === undefined ? "invisible" : "fan-in"}>{hero}</div>;
}

/** Content only for visitors who aren't signed in, such as the sign-up nudge. */
export function SignedOut({ children }: { children: React.ReactNode }) {
  const { user } = useUser();
  return user === null ? <>{children}</> : null;
}
