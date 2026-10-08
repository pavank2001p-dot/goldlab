import Link from "next/link";

export default function SignInPrompt({ what, next }: { what: string; next: string }) {
  return (
    <div className="mx-auto max-w-md px-4 py-14 text-center">
      <p className="text-muted">Create a free account or log in to {what}.</p>
      <div className="mt-4 flex justify-center gap-3">
        <Link href={`/signup?next=${next}`} className="rounded-md bg-gold px-4 py-2 font-medium text-black">Sign up free</Link>
        <Link href={`/login?next=${next}`} className="rounded-md border border-border px-4 py-2">Log in</Link>
      </div>
    </div>
  );
}
