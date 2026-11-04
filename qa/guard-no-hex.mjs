/* ── guard: no colour outside the token layer ─────────────────────────────────
   The CI colour gate for every source type at once — JSX, JS, TS, CSS, HTML, SVG
   — built from qa/color-rules.mjs, so it fails on exactly the patterns the census
   counted and on nothing else: raw hex, rgb()/rgba(), Tailwind greys and blues,
   the words blue/navy/lavender/cobalt…, `text-white`/`bg-white`, opacity-as-text,
   backdrop-filter, blur, gradient *paint* (a mask gradient is clipping, not a
   colour), soft shadows, and any hex or rgb whose hue lands in the banned blue
   band. Every failure prints file, line and the matched text.

   Scope comes from the import graph (qa/audit/reach.json, written by
   `node qa/reach.mjs`): a file nothing imports is not part of the product, so it
   is not linted — and importing it puts it straight back under the guard. No
   directory is ever exempted by name. Line-level exceptions must carry a visible
   marker (`guard-allow:` or `brand: third-party identity`) and are counted in the
   summary, so an exception can be reviewed rather than discovered later.

   The second half is the pairing: src/tokens.js restates the palette for WebGL
   and canvas, which cannot read a custom property. Every JS colour whose name
   exists in tokens.css must hold the same value in both, or this guard fails.

   Usage: node qa/guard-no-hex.mjs [--verbose] [--list-skipped] */
import fs from "node:fs";
import path from "node:path";
import { DARK, LIGHT } from "../src/tokens.js";
import { HEX, TOKEN_NAMES, findings, reachability, walk } from "./color-rules.mjs";

const ROOT = process.cwd();
const SRC = path.join(ROOT, "src");
const verbose = process.argv.includes("--verbose");
const listSkipped = process.argv.includes("--list-skipped");

/* Keys that exist only as 3D material/light inputs. They have no CSS counterpart
   by design — a studio key light is not a surface — so the pairing rule skips
   them by name, and only by name: a new key that is not listed still has to be
   defined in the stylesheet. */
const JS_ONLY_KEYS = new Set(["clay", "clayAlt", "clayLabel", "floor", "shadow", "key", "fill"]);

const kebab = name =>
  ({
    surface2: "surface-2",
    borderStrong: "border-strong",
    accentPress: "accent-press",
    accentText: "accent-text",
    onAccent: "on-accent"
  })[name] ?? name.replace(/[A-Z]/g, letter => `-${letter.toLowerCase()}`);

function declarations(css, selectors) {
  const out = new Map();
  for (const selector of selectors) {
    /* The selector is written without its brace: `:root,` (the dark block's first
       line) must not read as a `:root` rule. */
    const pattern = new RegExp(
      `${selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*\\{([\\s\\S]*?)\\n\\}`,
      "g"
    );
    for (const match of css.matchAll(pattern)) {
      for (const [, name, value] of match[1].matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) {
        out.set(name, value.trim());
      }
    }
  }
  return out;
}

/* A token may be declared as `var(--something)` (dark's --accent-text is
   `var(--accent)`); following the chain is what lets the guard compare the two
   palettes instead of waving at an indirection. */
function resolve(name, layer, base, depth = 0) {
  const raw = layer.get(name) ?? base.get(name);
  if (!raw) return null;
  const indirect = /^var\((--[\w-]+)\)$/.exec(raw);
  if (!indirect || depth > 8) return raw;
  return resolve(indirect[1], layer, base, depth + 1);
}

function pairingFailures() {
  const css = fs.readFileSync(path.join(SRC, "tokens.css"), "utf8");
  const base = declarations(css, [":root"]);
  const dark = declarations(css, ['html[data-theme="dark"]']);
  const light = declarations(css, ['html[data-theme="light"]']);
  const failures = [];
  for (const [theme, palette, layer] of [
    ["dark", DARK, dark],
    ["light", LIGHT, light]
  ]) {
    for (const [key, value] of Object.entries(palette)) {
      if (JS_ONLY_KEYS.has(key)) continue;
      const name = `--${kebab(key)}`;
      const declared = resolve(name, layer, base);
      if (!declared) {
        failures.push(`src/tokens.js ${theme}.${key} = ${value} has no ${name} in tokens.css`);
        continue;
      }
      const cssHex = (declared.match(HEX) ?? [])[0];
      if (!cssHex) {
        failures.push(`tokens.css ${name} (${theme}) is "${declared}", not a colour`);
        continue;
      }
      if (cssHex.toLowerCase() !== String(value).toLowerCase()) {
        failures.push(
          `${theme} palette disagrees: src/tokens.js ${key}=${value} but tokens.css ${name}=${cssHex}`
        );
      }
    }
  }
  return failures;
}

const skipped = reachability(ROOT);
const failures = [];
const exceptions = { brand: 0, guardAllow: 0 };
let linted = 0;
const skippedFiles = [];

for (const file of walk(SRC)) {
  const relative = path.relative(ROOT, file).replace(/\\/g, "/");
  if (TOKEN_NAMES.has(path.basename(file)) && !/components|pages|styles/.test(relative)) continue;
  const srcPath = relative.replace(/^src\//, "");
  if (skipped.has(srcPath)) {
    skippedFiles.push({ file: relative, lines: fs.readFileSync(file, "utf8").split("\n").length });
    continue;
  }
  linted += 1;
  for (const hit of findings(fs.readFileSync(file, "utf8"), {
    isCss: /\.(css|scss)$/.test(file)
  })) {
    if (hit.marker) {
      exceptions[hit.marker] += 1;
      if (verbose) console.log(`  exception (${hit.marker})  ${relative}:${hit.line}  ${hit.text.trim().slice(0, 90)}`);
      continue;
    }
    for (const { name, hits } of hit.found) {
      failures.push(
        `${relative}:${hit.line}  ${name} → ${[...new Set(hits)].join(", ")}\n      ${hit.text.trim().slice(0, 120)}`
      );
    }
  }
}

const paired = pairingFailures();

fs.mkdirSync(path.join(ROOT, "qa/audit"), { recursive: true });
fs.writeFileSync(
  path.join(ROOT, "qa/audit/guard-no-hex.json"),
  `${JSON.stringify({ linted, skipped: skippedFiles.length, exceptions, failures, pairing: paired }, null, 2)}\n`
);

console.log(`colour guard — ${linted} reachable source files scanned`);
if (listSkipped) {
  console.log(`\nskipped because nothing imports them (${skippedFiles.length}):`);
  for (const entry of skippedFiles) console.log(`  ${entry.file}`);
} else if (skippedFiles.length) {
  console.log(`  (${skippedFiles.length} unreachable vendored files not linted — --list-skipped)`);
}
console.log(
  `  documented line exceptions: ${exceptions.guardAllow} guard-allow, ${exceptions.brand} third-party brand`
);

for (const problem of paired) console.log(`\nTOKEN PAIRING  ${problem}`);
if (failures.length) {
  console.log(`\nFAIL  ${failures.length} colour violations in ${linted} reachable files:`);
  for (const failure of failures) console.log(`  ${failure}`);
}
if (failures.length || paired.length) {
  console.log(
    `\nguard-no-hex: FAIL (${failures.length} violations, ${paired.length} token-pairing problems)`
  );
  process.exit(1);
}
console.log(
  `guard-no-hex: PASS — no colour outside src/tokens.css and src/tokens.js, and all ${
    Object.keys(DARK).length * 2
  } JS palette values verified against the stylesheet`
);
