/* Which files can actually be reached from the app's entry points. Vendored
   components nobody imports are not a feature, so they must not be counted as
   "third-party source kept on purpose" — and they must not need a guard
   exclusion either. Read-only; writes qa/audit/reach.json. */
import fs from "node:fs";
import path from "node:path";

const ROOT = path.resolve("src");
const EXT = ["", ".js", ".jsx", ".ts", ".tsx", ".mjs", ".css"];
const entries = ["main.jsx", "App.jsx", "index.html"]
  .map(name => path.join(ROOT, name))
  .filter(file => fs.existsSync(file));

const rel = file => path.relative(ROOT, file).split(path.sep).join("/");

function resolve(from, spec) {
  if (!spec.startsWith(".") && !spec.startsWith("@/")) return null;
  const base = spec.startsWith("@/")
    ? path.join(ROOT, spec.slice(2))
    : path.resolve(path.dirname(from), spec);
  for (const ext of EXT) {
    const candidate = base + ext;
    if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return candidate;
  }
  for (const ext of EXT.slice(1)) {
    const candidate = path.join(base, `index${ext}`);
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

/* Multi-line import clauses are the common case in this codebase, so the
   specifier search has to cross newlines — a `[^\n]` class reports half the app
   as unreachable. */
const SPEC =
  /(?:^|[\s;)}])(?:import|export)\b[\s\S]{0,400}?\bfrom\s*["']([^"']+)["']|import\s+["']([^"']+)["']|\bimport\(\s*["']([^"']+)["']\s*\)|\brequire\(\s*["']([^"']+)["']\s*\)/g;

const seen = new Set();
const queue = [...entries];
while (queue.length) {
  const file = queue.pop();
  if (seen.has(file) || !fs.existsSync(file)) continue;
  seen.add(file);
  const source = fs.readFileSync(file, "utf8");
  for (const match of source.matchAll(SPEC)) {
    const spec = match[1] ?? match[2] ?? match[3];
    const next = resolve(file, spec);
    if (next) queue.push(next);
  }
}

const all = [];
(function walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full);
    else if (/\.(jsx?|tsx?|mjs|css)$/.test(entry.name)) all.push(full);
  }
})(ROOT);

const skip = /(?:tokens\.css|styles\.css|vite-env\.d\.ts)$/;
const unreachable = all.filter(file => !seen.has(file) && !skip.test(file));

console.log(`reachable: ${seen.size} of ${all.length} src files`);
console.log(`\nunreachable (${unreachable.length}):`);
for (const file of unreachable) console.log(`  ${rel(file)}`);
fs.mkdirSync("qa/audit", { recursive: true });
fs.writeFileSync(
  "qa/audit/reach.json",
  `${JSON.stringify({ reachable: seen.size, unreachable: unreachable.map(rel) }, null, 2)}\n`
);
