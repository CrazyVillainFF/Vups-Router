/* ── colour census: the same patterns, run twice ────────────────────────────────
   The addendum demands a before/after count measured by *identical* searches, so
   the patterns live in qa/color-rules.mjs and this file only tallies what that
   module reports. `--scan=DIR` points it at a snapshot (qa/_backup/src-20261102-141004
   is the pre-migration tree) and `--out=NAME` keeps the two reports from
   overwriting each other. Read-only.

   A match is only a violation when it can paint; that judgement is color-rules'
   job, not this file's, so the guard and the census can never drift apart. */
import fs from "node:fs";
import path from "node:path";
import { MEASURED, TOKEN_NAMES, findings, walk } from "./color-rules.mjs";

const arg = name => {
  const hit = process.argv.find(value => value.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : null;
};
const ROOT = path.resolve(arg("root") ?? ".");
const SCAN = arg("scan") ?? "src";
const OUT = arg("out") ?? "colors";

const rows = [];
const totals = {};
const filesWith = {};
for (const key of [...MEASURED, "violations", "brand", "guardAllow"]) {
  totals[key] = 0;
  filesWith[key] = 0;
}

const scanned = path.resolve(ROOT, SCAN);
if (!fs.existsSync(scanned)) {
  console.error(`nothing to scan at ${scanned}`);
  process.exit(2);
}

for (const file of walk(scanned)) {
  const relative = path.relative(ROOT, file).replace(/\\/g, "/");
  const isToken = TOKEN_NAMES.has(path.basename(file)) && !/components|pages|styles/.test(relative);
  const row = { file: relative, tokenFile: isToken, violations: 0, brand: 0, guardAllow: 0 };
  for (const key of MEASURED) row[key] = 0;

  for (const hit of findings(fs.readFileSync(file, "utf8"), {
    isCss: /\.(css|scss)$/.test(file)
  })) {
    if (hit.marker === "guardAllow") {
      row.guardAllow += 1;
      continue;
    }
    if (hit.marker === "brand") {
      row.brand += 1;
      continue;
    }
    let offending = false;
    for (const { name, hits } of hit.found) {
      row[name] += hits.length;
      offending = true;
    }
    if (!isToken && offending) row.violations += 1;
  }

  for (const key of MEASURED) {
    totals[key] += row[key];
    if (row[key] > 0) filesWith[key] += 1;
  }
  for (const key of ["violations", "brand", "guardAllow"]) {
    totals[key] += row[key];
    if (row[key] > 0) filesWith[key] += 1;
  }
  if (row.violations > 0 || row.brand || row.guardAllow) rows.push(row);
}

rows.sort((a, b) => b.violations - a.violations || a.file.localeCompare(b.file));

const outDir = path.resolve(ROOT, "qa/audit");
fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(
  path.join(outDir, `${OUT}.json`),
  `${JSON.stringify({ scanned, totals, filesWith, files: rows.length, rows }, null, 2)}\n`
);

const keys = [...MEASURED, "violations", "brand", "guardAllow"];
const lines = [
  `# Colour census — ${scanned}`,
  "",
  "`violations` counts offending *lines*, so one line that names a hex twice is one",
  "thing to fix. The token layer is reported apart because naming a colour is its",
  "only permitted job; `brand` and `guardAllow` lines carry an explicit marker.",
  "",
  "| pattern | matches | files |",
  "| --- | --: | --: |",
  ...keys.map(key => `| ${key} | ${totals[key]} | ${filesWith[key] ?? 0} |`),
  "",
  `files still carrying a violation: ${rows.filter(row => row.violations > 0).length}`,
  "",
  "## Per file",
  "",
  `| file | ${keys.join(" | ")} |`,
  `| --- |${keys.map(() => " --: |").join("")}`,
  ...rows.map(row => `| ${row.file} | ${keys.map(key => row[key] ?? 0).join(" | ")} |`)
];
fs.writeFileSync(path.join(outDir, `${OUT}.md`), `${lines.join("\n")}\n`);

console.log(`scanned ${scanned}`);
for (const key of keys) console.log(`  ${key.padEnd(20)} ${String(totals[key]).padStart(6)}  in ${filesWith[key] ?? 0} files`);
console.log(`  files with violations: ${rows.filter(row => row.violations > 0).length}`);
