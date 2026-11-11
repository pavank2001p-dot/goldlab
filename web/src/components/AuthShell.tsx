// The card shared by the sign-in, sign-up, password and email pages.
export const authInput =
  "w-full rounded-lg border border-border bg-background px-3 py-2 outline-none transition focus:border-gold focus:shadow-[0_0_0_3px_color-mix(in_srgb,var(--gold)_15%,transparent)]";
export const authButton = "w-full rounded-lg bg-gold py-2 font-medium text-black hover:opacity-90 disabled:opacity-60";

export default function AuthShell({ title, intro, children }: { title: string; intro?: React.ReactNode; children: React.ReactNode }) {
  return (
    <div className="relative mx-auto max-w-sm px-4 py-14">
      <div aria-hidden className="pointer-events-none absolute left-1/2 top-6 h-40 w-72 -translate-x-1/2 rounded-full bg-gold/10 blur-3xl" />
      <div className="relative rounded-2xl border border-border bg-surface p-6">
        <span className="flex h-10 w-10 items-center justify-center rounded-2xl bg-gradient-to-br from-gold to-gold-deep">
          <span className="h-3 w-3 rotate-45 rounded-[3px] bg-black/80" />
        </span>
        <h1 className="mt-4 text-2xl font-semibold">{title}</h1>
        {intro && <p className="mt-1 text-sm text-muted">{intro}</p>}
        {children}
      </div>
    </div>
  );
}
