import type { CoachTag, CoachTags } from "@/lib/api";

/** Short labels for the mistakes the coach found on one trade. */
export default function TagChips({ tags, labels }: { tags?: CoachTag[]; labels?: CoachTags["labels"] }) {
  if (!tags?.length || !labels) return null;
  return (
    <span className="flex flex-wrap gap-1">
      {tags.map((t) => (
        <span key={t} title={labels[t]?.explain} className="rounded-full bg-down/15 px-2 py-0.5 text-[11px] text-down">
          {labels[t]?.label ?? t}
        </span>
      ))}
    </span>
  );
}
