// Lists English strings passed to t("...") that a catalog doesn't translate yet.
// Usage: npm run i18n:check   (exits 1 when anything is missing, so CI can use it)
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const root = new URL("../src", import.meta.url).pathname;
const files = [];
(function walk(d) {
  for (const f of readdirSync(d)) {
    const p = join(d, f);
    if (statSync(p).isDirectory()) walk(p);
    else if (/\.tsx?$/.test(f) && !p.includes("/i18n/")) files.push(p);
  }
})(root);

const used = new Set();
const re = /\b(?:t|msg)\(\s*("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*')/g;
for (const f of files) for (const m of readFileSync(f, "utf8").matchAll(re)) used.add(JSON.parse(m[1].replace(/^'|'$/g, '"')));

let missing = 0;
for (const f of readdirSync(join(root, "i18n")).filter((f) => f !== "index.ts")) {
  const text = readFileSync(join(root, "i18n", f), "utf8");
  const keys = new Set([...text.matchAll(/^\s*("(?:[^"\\]|\\.)*"):/gm)].map((m) => JSON.parse(m[1])));
  const gaps = [...used].filter((s) => !keys.has(s));
  missing += gaps.length;
  console.log(`${f}: ${used.size - gaps.length}/${used.size} translated`);
  for (const g of gaps) console.log(`  missing: ${g}`);
}
process.exit(missing ? 1 : 0);
