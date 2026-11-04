/* Intersect the colour census with the reachable module graph so the purge
   worklist contains only code that actually ships, and no directory needs to
   be excluded to make a guard pass.

   Rows come from qa/audit-colors.mjs: `violations` is the number of offending
   *lines* in the file (already zero for the token layer and for lines carrying
   an explicit marker), and every other key is that line's pattern count. */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const qaRoot = path.dirname(fileURLToPath(import.meta.url));
const clientRoot = path.resolve(qaRoot, "..");
const auditName = process.argv[2] ?? "colors-after.json";

const audit = JSON.parse(fs.readFileSync(path.join(clientRoot, "qa", "audit", auditName), "utf8"));
const reach = JSON.parse(fs.readFileSync(path.join(clientRoot, "qa", "audit", "reach.json"), "utf8"));
const unreachable = new Set(reach.unreachable);

const skipped = new Map();
const byFile = [];
for (const row of audit.rows) {
  if (!row.violations) continue;
  /* A before-snapshot lives under qa/_backup/src-<stamp>/, so its paths are
     rebased onto src/ here and both runs meet the same reach set. */
  const rel = row.file
    .split("/")
    .slice(row.file.split("/").findIndex(segment => /^src/.test(segment)) + 1)
    .join("/");
  if (unreachable.has(rel)) {
    skipped.set(rel, row.violations);
    continue;
  }
  const patterns = Object.entries(row)
    .filter(([key, value]) => typeof value === "number" && value > 0 && !["violations", "brand", "guardAllow", "tokenFile"].includes(key))
    .map(([key, value]) => `${key}:${value}`)
    .join(" ");
  byFile.push({ rel, violations: row.violations, patterns });
}

byFile.sort((a, b) => b.violations - a.violations || a.rel.localeCompare(b.rel));
let total = 0;
for (const row of byFile) {
  total += row.violations;
  console.log(`${String(row.violations).padStart(4)}  ${row.rel}  ${row.patterns}`);
}
const skippedTotal = [...skipped.values()].reduce((a, b) => a + b, 0);
console.log(`\nreachable violating files: ${byFile.length}  offending lines: ${total}`);
console.log(`out of scope (not in the reachable module graph): ${skipped.size} files, ${skippedTotal} lines`);
for (const [file, count] of [...skipped].sort((a, b) => b[1] - a[1]).slice(0, 12)) {
  console.log(`  ${String(count).padStart(4)}  ${file}`);
}
