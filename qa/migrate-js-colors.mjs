/* Second half of the colour sweep: the literals that live in JavaScript.

     node qa/migrate-js-colors.mjs --check
     node qa/migrate-js-colors.mjs

   A stylesheet value can name a token (`var(--accent)`) and the browser does the
   rest. A JavaScript string has two very different destinations, so the sweep
   splits on that:

     • anything that ends up in the DOM — inline styles, MUI `sx`, SVG
       `fill`/`stroke`, CSS custom properties — becomes the same `var()` /
       `color-mix()` text the CSS sweep writes, so both layers agree;
     • anything that reaches a canvas or a WebGL material cannot parse `var()` at
       all. There the *whole* string is replaced by a call — `"#6c9bff"` becomes
       `token("accent")`, `color="#6c9bff"` becomes `color={token("accent")}` —
       because leaving the quotes around a call was the first version's bug: it
       produced the string `"token("text")"`, which is not valid JavaScript.

   A canvas line whose colour is embedded in a longer string (a gradient stop
   list, a shadow recipe) is reported instead of guessed at.

   Colour comparisons are logic, not paint (`if (normal !== "#000000")`), so the
   sweep refuses to touch a literal inside a comparison or a regex and lists the
   line for a human. A provider's own hue is third-party identity — the same kind
   of fact as its logo — so those rows keep their literal and carry the marker the
   colour guard reads as its one narrow exception. */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const clientRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const srcArg = process.argv.find(arg => arg.startsWith("--src="));
const srcRoot = srcArg ? path.resolve(clientRoot, srcArg.slice(6)) : path.join(clientRoot, "src");
const CHECK = process.argv.includes("--check");
const SKIP = new Set([path.join(srcRoot, "tokens.css"), path.join(srcRoot, "tokens.js")]);

const COLOR_RE = /#[0-9a-fA-F]{3,8}\b|rgba?\([^()]*\)/g;
const COLOR_SRC = String.raw`(?:#[0-9a-fA-F]{3,8}|rgba?\([^()]*\))`;
/* Reuse the CSS sweep's judgement verbatim, then read the token name back out of
   its answer, so one colour can never map to two different tokens. */
const { mapColor, roleFor } = await import("./migrate-colors.mjs");

const specFromCss = cssValue => {
  const mix = cssValue.match(/var\(--([a-z0-9-]+)\)\s+(\d+(?:\.\d+)?)%/);
  if (mix) return { name: mix[1], alpha: Number(mix[2]) / 100 };
  const single = cssValue.match(/^var\(--([a-z0-9-]+)\)$/);
  if (single) return { name: single[1], alpha: null };
  return null;
};

const jsCall = (spec, names) =>
  spec.alpha === null
    ? `${names.token}("${spec.name}")`
    : `${names.mix}("${spec.name}", ${spec.alpha})`;

/* A file that paints through an API with no CSS engine behind it. */
const CANVAS_FILE = /from "three|@react-three|addColorStop|fillStyle|strokeStyle|shadowColor|getContext\(|CanvasTexture|createRadialGradient|createLinearGradient/;
/* …and a line inside any file that is definitely DOM paint, even in a canvas file.
   A `colorContext` probe is *not* DOM paint: a 2D context parses a colour string
   itself and silently keeps the previous value when it cannot, so `var()` there
   is a bug, not a token. */
const DOM_LINE = /style=\{\{|sx=\{\{|\bcss\(|["'`]--[a-z]|textColor=|backgroundColor=/;
/* The line that needs a call rather than a string. */
const CANVAS_LINE =
  /addColorStop|fillStyle|strokeStyle|shadowColor|createRadialGradient|createLinearGradient|new THREE|THREE\.Color|emissive|attenuationColor|<mesh|<Mesh|<pointLight|<spotLight|<ambientLight|<directionalLight|<hemisphereLight|<color|material|Material|glowSprite|drawImage|setColor|hexToRgb|toRgb|lerpColor|\bctx\./;

/* A literal being *compared* is part of a decision, not a colour. */
const LOGIC_LINE = /[!=]==?\s*["'`]?#|["'`]?#[0-9a-fA-F]{3,8}["'`]?\s*[!=]==?|\/\^?\(?#[0-9a-fA-F]/;

/* The provider catalogue: a row that names a company and carries a hue. */
const BRAND_LINE = line =>
  Boolean(line.match(COLOR_RE)) &&
  /(wordmark|src|logo|brand|name)\s*:/.test(line) &&
  /(^|[{,\s])(color|brandColor|logoColor)\s*:/.test(line);

const JSX_ATTR = new RegExp(`([A-Za-z][\\w-]*)=["'\`](${COLOR_SRC})["'\`]`, "g");
const WHOLE_STRING = new RegExp(`(?<![=])["'\`](${COLOR_SRC})["'\`]`, "g");

const KEY_ROLE = [
  [/^(fill|stopcolor|floodcolor|lightingcolor|emissive)$/i, "svg"],
  [/^(stroke|strokecolor|line|rule|divider|edge|border|bordercolor)$/i, "border"],
  [/^(background|backgroundcolor|bgcolor|surface|panel|card|track|plate|shell|housing|clay|floor|menubackground)$/i, "bg"],
  [/^(color|ink|inkcolor|foreground|fg|digitcolor|labelcolor|titlecolor|fromcolor|tocolor|basecolor|highlightcolor|body|text)$/i, "text"],
  [/^(glowcolor|shadowcolor|shadow|rim|sparkcolor|trailcolor|shinecolor|glarecolor|cursorcolor|dangercolor|spotlightcolor|slotcolor|scramblecolor|pressurecolor|tint|key|light|accent)$/i, "accentable"]
];

function roleForJs(key, fallback) {
  if (!key) return fallback;
  const name = key.replace(/^["']|["']$/g, "").replace(/^&/, "");
  for (const [pattern, role] of KEY_ROLE) {
    if (!pattern.test(name)) continue;
    /* A "danger red" or a "spark blue" was never a surface: those names want the
       accent, so they take the generic ladder rather than the border rule. */
    return role === "accentable" ? "generic" : role;
  }
  return roleFor(name);
}

/* The identifier a literal belongs to: `color: "#6c9bff"`, `textColor="#6c9bff"`,
   `"--pb-ink": "#e9eef7"`. */
function keyForMatch(line, index) {
  const before = line.slice(0, index);
  const attr = before.match(/([A-Za-z_$][\w-]*)\s*=\s*["'`][^"'`]*$/);
  if (attr) return attr[1];
  const quotedKey = before.match(/(["'`])(--[\w-]+|[\w-]+)\1\s*:\s*[^"'`]*$/);
  if (quotedKey) return quotedKey[2];
  const obj = before.match(/([A-Za-z_$][\w-]*)\s*:\s*["'`]?[^"'`]*$/);
  if (obj) return obj[1];
  return null;
}

function migrateLine(line, canvasFile, names) {
  if (LOGIC_LINE.test(line)) return { line, skipped: line.trim() };
  if (BRAND_LINE(line)) {
    if (/brand: third-party identity/.test(line)) return { line };
    return { line: `${line} /* brand: third-party identity */`, brand: true };
  }
  if (!line.match(COLOR_RE)) return { line };

  const domPaint = DOM_LINE.test(line);
  const canvas = !domPaint && (canvasFile || CANVAS_LINE.test(line));

  if (!canvas) {
    let changed = false;
    const next = line.replace(COLOR_RE, (raw, ...rest) => {
      const key = keyForMatch(line, rest[rest.length - 2]);
      const mapped = mapColor(raw, roleForJs(key, "generic"));
      if (mapped !== raw) changed = true;
      return mapped;
    });
    return changed ? { line: next } : { line };
  }

  let changed = false;
  let next = line.replace(JSX_ATTR, (match, attr, colour) => {
    const spec = specFromCss(mapColor(colour, roleForJs(attr, "bg")));
    if (!spec) return match;
    changed = true;
    return `${attr}={${jsCall(spec, names)}}`;
  });
  next = next.replace(WHOLE_STRING, (match, colour) => {
    const spec = specFromCss(mapColor(colour, "bg"));
    if (!spec) return match;
    changed = true;
    return jsCall(spec, names);
  });
  if (!changed) return { line };
  const residual = next.match(COLOR_RE);
  return residual
    ? { line: next, skipped: `canvas literal inside a longer string: ${next.trim().slice(0, 140)}` }
    : { line: next };
}

function walk(dir) {
  const files = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) files.push(...walk(full));
    else if (/\.jsx?$/.test(entry.name)) files.push(full);
  }
  return files;
}

let filesTouched = 0;
let literals = 0;
let brands = 0;
const skipped = [];
const needsTokenImport = [];

/* `mix` and `token` are common local helper names in this codebase (a lerp in
   Stack, an rgb blender in StarBorder), and an import that shadows one is a
   syntax error. Bind the palette API under a name the file has not taken. */
function bindNames(source) {
  const taken = new Set();
  for (const [, name] of source.matchAll(/(?:const|let|var|function|class)\s+([A-Za-z_$][\w$]*)/g)) {
    taken.add(name);
  }
  for (const [, clause] of source.matchAll(/^import\s*\{([^}]*)\}/gm)) {
    for (const part of clause.split(",")) {
      const last = part.trim().split(/\s+as\s+/).pop();
      if (last) taken.add(last);
    }
  }
  const free = preferred => (taken.has(preferred) ? `${preferred}Color` : preferred);
  return { token: free("token"), mix: free("mix") };
}

for (const file of walk(srcRoot)) {
  if (SKIP.has(file)) continue;
  const source = fs.readFileSync(file, "utf8");
  if (!source.match(COLOR_RE)) continue;
  const canvasFile = CANVAS_FILE.test(source);
  const names = bindNames(source);
  const lines = source.split("\n");
  const out = [];
  let usesToken = false;
  let usesMix = false;
  let count = 0;
  let brandMarked = 0;
  const preview = [];
  for (const line of lines) {
    const result = migrateLine(line, canvasFile, names);
    if (result.skipped) skipped.push(`${path.relative(srcRoot, file)}: ${result.skipped}`);
    if (result.brand) brandMarked += 1;
    if (result.line !== line) {
      count += (line.match(COLOR_RE) || []).length;
      /* Match the emitted *call*, not the substring: `color-mix(` is CSS paint
         and needs no import at all. */
      if (new RegExp(`(^|[^$.\\w-])${names.token}\\(`).test(result.line)) usesToken = true;
      if (new RegExp(`(^|[^$.\\w-])${names.mix}\\(`).test(result.line)) usesMix = true;
      if (CHECK && preview.length < 10) {
        preview.push(`        - ${line.trim().slice(0, 150)}\n        + ${result.line.trim().slice(0, 150)}`);
      }
    }
    out.push(result.line);
  }
  if (!count) continue;
  filesTouched += 1;
  literals += count;
  brands += brandMarked;
  if (usesToken || usesMix) {
    const rel = path.relative(srcRoot, file).replace(/\\/g, "/");
    const depth = (rel.match(/\//g) || []).length;
    const target = `${depth ? "../".repeat(depth) : "./"}tokens.js`;
    /* [export name in tokens.js, name bound in this file] — they differ when the
       file had already taken `mix` or `token` for a local helper. */
    const wanted = [
      usesToken ? ["token", names.token] : null,
      usesMix ? ["mix", names.mix] : null
    ].filter(Boolean);
    const statement = out
      .join("\n")
      .match(/import\s*\{([^}]*)\}\s*from\s*["'][^"']*\/?tokens\.js["'];?/);
    const bound = statement
      ? statement[1]
          .split(",")
          .map(part => part.trim().split(/\s+as\s+/).pop())
          .filter(Boolean)
      : [];
    const missing = wanted.filter(([, local]) => !bound.includes(local));
    if (missing.length) {
      needsTokenImport.push([file, target, missing.map(([exp, local]) => (exp === local ? exp : `${exp} as ${local}`)), statement ? statement[0] : null]);
    }
  }
  console.log(
    `${String(count).padStart(4)}  ${path.relative(srcRoot, file)}` +
      `${canvasFile ? "  [canvas file]" : ""}${brandMarked ? `  (${brandMarked} brand rows kept)` : ""}`
  );
  if (CHECK) for (const line of preview) console.log(line);
  if (!CHECK) fs.writeFileSync(file, out.join("\n"));
}

for (const [file, target, names, existingStatement] of needsTokenImport) {
  const source = fs.readFileSync(file, "utf8");
  const patched = existingStatement
    ? source.replace(
        existingStatement,
        existingStatement.replace(/\{([^}]*)\}/, (_, inner) => {
          const bound = inner.trim().split(",").filter(Boolean).map(part => part.trim());
          return `{ ${[...bound, ...names].join(", ")} }`;
        })
      )
    : (() => {
        const statement = `import { ${names.join(", ")} } from "${target}";\n`;
        const firstImport = source.match(/^import [^\n]*\n/m);
        return firstImport
          ? source.slice(0, firstImport.index) + statement + source.slice(firstImport.index)
          : `${statement}${source}`;
      })();
  fs.writeFileSync(file, patched);
}

console.log(
  `${CHECK ? "would rewrite" : "rewritten"}: ${filesTouched} files, ${literals} literals, ` +
    `${needsTokenImport.length} token imports, ${brands} brand rows kept as third-party identity`
);
if (skipped.length) {
  console.log(`\nneeds a human (paint inside a longer string, or colour used as logic):`);
  for (const line of skipped) console.log(`  ${line}`);
}
