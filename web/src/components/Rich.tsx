import Link from "next/link";
import { Fragment } from "react";

const BULLET = /^\s*(?:[-*•]|\d+\.)\s+/;
// [text](/path): links to pages on this site only. Anything else stays plain text.
const LINK = /^\[([^\]]+)\]\((\/(?!\/)[^\s)]*)\)$/;
const LINKS = /(\[[^\]]+\]\(\/(?!\/)[^\s)]*\))/;

/** Renders the assistant's plain text: paragraphs, "- " bullet lists, **bold** and links within the site. No HTML is injected. */
export default function Rich({ text }: { text: string }) {
  const bold = (s: string, key: string) =>
    s.split(/(\*\*[^*]+\*\*)/).map((part, i) =>
      part.startsWith("**") && part.endsWith("**") ? <strong key={`${key}-${i}`}>{part.slice(2, -2)}</strong> : <Fragment key={`${key}-${i}`}>{part}</Fragment>,
    );
  const inline = (s: string) =>
    s.split(LINKS).flatMap((part, i) => {
      const m = part.match(LINK);
      return m
        ? [<Link key={i} href={m[2]} className="font-medium text-gold underline underline-offset-2 hover:brightness-110">{m[1]}</Link>]
        : bold(part, String(i));
    });
  return (
    <>
      {text.split(/\n{2,}/).map((block, i) => {
        // Group consecutive bullet lines into a list; other lines stay as text.
        const parts: { list: boolean; lines: string[] }[] = [];
        for (const raw of block.split("\n")) {
          // Headings come out as bold lines.
          const line = /^#{1,6}\s+/.test(raw) ? `**${raw.replace(/^#{1,6}\s+/, "").replace(/\*\*/g, "")}**` : raw;
          const list = BULLET.test(line);
          const last = parts[parts.length - 1];
          if (last && last.list === list) last.lines.push(list ? line.replace(BULLET, "") : line);
          else parts.push({ list, lines: [list ? line.replace(BULLET, "") : line] });
        }
        return (
          <Fragment key={i}>
            {parts.map((p, j) =>
              p.list ? (
                <ul key={j} className="my-2 list-disc space-y-1 pl-5">
                  {p.lines.map((l, k) => <li key={k}>{inline(l)}</li>)}
                </ul>
              ) : (
                <p key={j} className="my-2 whitespace-pre-line">{inline(p.lines.join("\n"))}</p>
              ),
            )}
          </Fragment>
        );
      })}
    </>
  );
}
