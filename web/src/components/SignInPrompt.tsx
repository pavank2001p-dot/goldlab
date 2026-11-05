import Link from "next/link";
import { Icon } from "./ui";

export default function SignInPrompt({ what, next }: { what: string; next: string }) {
  return (
    <div className="mx-auto max-w-md px-4 py-16 text-center">
      <span className="mx-auto flex h-14 w-14 items-center justify-center rounded-2xl border border-gold/30 bg-gradient-to-br from-gold/25 to-gold/5 text-gold">
        <Icon name="account" className="h-7 w-7" />
      </span>
      <p className="mt-4 text-muted">Create a free account or log in to {what}.</p>
      <div className="mt-4 flex justify-center gap-3">
        <Link href={`/signup?next=${next}`} className="rounded-md bg-gold px-4 py-2 font-medium text-black">Sign up free</Link>
        <Link href={`/login?next=${next}`} className="rounded-md border border-border px-4 py-2">Log in</Link>
      </div>
    </div>
  );
}
