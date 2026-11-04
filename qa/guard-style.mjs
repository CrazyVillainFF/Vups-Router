/* ── guard: the CSS lint gate ──────────────────────────────────────────────────
   Runs stylelint (stylelint.config.mjs: no raw hex, no gradient paint, no
   backdrop-filter, hard-offset shadows only) over the stylesheet set. The file
   list comes from the same import graph qa/guard-no-hex.mjs uses, so a vendored
   stylesheet nobody imports is not linted and importing it puts it back under the
   rule — no directory is exempted by name, and the linted scope is printed so a
   reviewer can see exactly what was checked. */
import path from "node:path";
import fs from "node:fs";
import stylelint from "stylelint";
import { reachability } from "./color-rules.mjs";

const ROOT = process.cwd();

const files = [];
const glob = dir => {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) glob(full);
    else if (/\.css$/.test(entry.name)) files.push(full);
  }
};
glob(path.join(ROOT, "src"));

const skipped = reachability(ROOT);
/* reach.mjs never lists tokens.css or styles.css as unreachable, so both are
   always linted; the hex exemption for the token file is a rule override in the
   config, where it is visible, not a file left out of the run. */
const targets = files
  .map(file => path.relative(ROOT, file).replace(/\\/g, "/"))
  .filter(relative => !skipped.has(relative.replace(/^src\//, "")));

const { results } = await stylelint.lint({
  files: targets,
  configFile: path.join(ROOT, "stylelint.config.mjs")
});

/* Printed by hand rather than through stylelint.formatters: a gate has to name the
   file, the line and the rule in the shape the rest of qa/ prints. */
const reported = results
  .filter(result => result.warnings.length)
  .map(result => {
    const relative = path.relative(ROOT, result.source).replace(/\\/g, "/");
    return result.warnings
      .map(warning => `  ${relative}:${warning.line}:${warning.column}  ${warning.rule}  ${warning.text}`)
      .join("\n");
  })
  .join("\n");
if (reported) console.log(reported);

const problems = results
  .filter(result => result.warnings.length)
  .map(result => `${path.relative(ROOT, result.source).replace(/\\/g, "/")}: ${result.warnings.length}`);

console.log(`stylelint — ${targets.length} reachable stylesheets linted`);
if (problems.length) {
  console.log(`\nguard-style: FAIL (${problems.join(", ")})`);
  process.exit(1);
}
console.log("guard-style: PASS");
