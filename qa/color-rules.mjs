/* ── the colour rules, in one place ────────────────────────────────────────────
   The census (qa/audit-colors.mjs) and the release guards (qa/guard-*.mjs) must
   disagree about nothing, so both read their definitions from this file. A second
   copy of "what counts as blue" is how a guard quietly becomes softer than the
   audit that justified it.

   A match is only a violation when it can paint. That distinction is the whole
   job of this file: `0 2px 0` is the required hard-offset shadow and `0 2px 4px`
   is the banned soft one, `mask-image: linear-gradient(black 0 0)` is geometry
   and `background: linear-gradient(…)` is a gradient, and a comment that says
   "the old blue was removed" is prose. Counting them as failures is how a guard
   gets weakened by whoever runs it next. */
import fs from "node:fs";
import path from "node:path";

export const EXTENSIONS = new Set([".css", ".jsx", ".js", ".ts", ".tsx", ".html", ".svg", ".mjs"]);
/* Only the token layer is allowed to name a colour, so it is reported apart
   rather than quietly excluded — an exception has to be visible to be allowed. */
export const TOKEN_NAMES = new Set(["tokens.css", "tokens.js"]);

export const HEX = /#(?:[0-9a-f]{3,4}|\b[0-9a-f]{6}\b|[0-9a-f]{8})\b/gi;
export const RGB = /\brgba?\(\s*[\d.]+\s*,\s*[\d.]+\s*,\s*[\d.]+/gi;

export const PATTERNS = {
  hex: HEX,
  rgb: RGB,
  whiteText: /\btext-white\b|\btext-\[white\]|\btext-\[#(?:fff|ffffff)\b/gi,
  whiteBackground: /\bbg-white\b|\bbg-\[white\]|\bbg-\[#(?:fff|ffffff)\b/gi,
  whiteAlphaBackground: /\bbg-white\/\d+|\bbg-\[rgba\(\s*255\s*,\s*255\s*,\s*255/gi,
  whiteBorder: /\bborder-white\b|\bborder-\[white\]|\bborder-\[#(?:fff|ffffff)\b/gi,
  whiteRgbLiteral: /rgba\(\s*255\s*,\s*255\s*,\s*255/gi,
  blackRgbLiteral: /rgba?\(\s*0\s*,\s*0\s*,\s*0/gi,
  pureWhiteKeyword: /(?:color|fill|stroke)\s*:\s*white\b|(?:color|fill|stroke)\s*=\s*["']white["']/gi,
  greyscaleTailwind: /\b(?:text|bg|border|fill)-(?:slate|gray|grey|zinc|neutral|stone)-\d{2,3}\b/g,
  blueTailwindClass: /\b(?:text|bg|border|from|to|via|ring|fill|stroke|shadow|decoration|outline)-(?:blue|sky|indigo|violet|purple|cyan)-[\w-]+/g,
  /* "Azure" is the Microsoft provider name in this codebase, not a colour someone
     paints with — provider ids, endpoint hosts and marketing copy would all be
     flagged. Actual azure-painted pixels are caught by blueHex/blueRgb, which look
     at the value rather than the word, so dropping it here loses no coverage. */
  blueWord: /\b(?:blue|navy|periwinkle|lavender|lilac|indigo|violet|cobalt)\b/gi,
  /* Values of `none` are removed before this runs — see stripMasks — so a match
     here means the feature is actually switched on. */
  backdropFilter:
    /(?:^|[\s;{])-webkit-backdrop-filter\s*:|(?<!-webkit-)backdrop-filter\s*:|\bbackdropFilter\s*:/g,
  filterBlur:
    /(?:^|[\s;{])filter\s*:[^;\n]*(?:\bblur\(|\bdrop-shadow\()|\bdrop-shadow\(|\bfilter\s*:\s*["'`][^"'`]*\bblur\(/gi,
  opacityText: /\b(?:text|placeholder|decoration)-(?:white|black)\/\d+|\bcolor\s*:\s*rgba?\(\s*(?:255|0)\s*,\s*(?:255|0)\s*,\s*(?:255|0)\s*,/g,
  svgColor: /(?:fill|stroke)\s*=\s*["']#(?:[0-9a-f]{3,8})["']/gi,
  threeColor: /new THREE\.Color\(\s*["']#|color:\s*["']#[0-9a-f]{6}["']/gi,
  inlineHex: /style=\{\{[^}]*#[0-9a-f]{3,8}/gi
};

export const MARKER_GUARD = /guard-allow:/;
export const MARKER_BRAND = /brand: third-party identity/;

/* Comments are prose about the design, not paint — "the old blue was removed"
   must not count as a use of blue. Blanking them character-for-character (newlines
   kept) means every later measurement still sits on its real line, and a comment
   that spans ten lines is invisible to all of them instead of leaking eight.
   Quote-aware, so a `//` inside a string is not mistaken for a comment, and
   `https://` survives because a colon precedes it. */
export function blankComments(text) {
  const markers = [];
  const out = [];
  let index = 0;
  let line = 0;
  let quote = null;
  while (index < text.length) {
    const char = text[index];
    const next = text[index + 1];
    if (char === "\n") {
      line += 1;
      index += 1;
      out.push(char);
      continue;
    }
    if (quote) {
      /* A template literal may hold interpolation, and inside it anything can
         look like a comment; the census does not need to parse it correctly to
         leave the colour literals visible. */
      if (char === "\\") {
        out.push(char, next ?? "");
        index += 2;
        continue;
      }
      if (char === quote) quote = null;
      out.push(char);
      index += 1;
      continue;
    }
    if (char === '"' || char === "'" || char === "`") {
      quote = char;
      out.push(char);
      index += 1;
      continue;
    }
    if (char === "/" && next === "*") {
      const end = text.indexOf("*/", index + 2);
      const span = end === -1 ? text.length : end + 2;
      const body = text.slice(index, span);
      const lines = (body.match(/\n/g) ?? []).length;
      /* A marker comment may run over several lines and still sit directly above
         the code it excuses, so every line it touches carries the exception. */
      const kind = MARKER_GUARD.test(body) ? "guardAllow" : MARKER_BRAND.test(body) ? "brand" : null;
      if (kind) for (let touched = 0; touched <= lines; touched += 1) markers[line + touched] ??= kind;
      for (const c of body) out.push(c === "\n" ? "\n" : " ");
      line += lines;
      index = span;
      continue;
    }
    if (char === "/" && next === "/" && text[index - 1] !== ":") {
      const end = text.indexOf("\n", index);
      const stop = end === -1 ? text.length : end;
      const body = text.slice(index, stop);
      if (MARKER_GUARD.test(body)) markers[line] = "guardAllow";
      if (MARKER_BRAND.test(body)) markers[line] = "brand";
      out.push(" ".repeat(body.length));
      index = stop;
      continue;
    }
    out.push(char);
    index += 1;
  }
  return { code: out.join(""), markers };
}

/* A CSS declaration can wrap, and a wrapped `box-shadow:` would be measured a
   line at a time. Joining continuations keeps the shadow parser honest without
   collapsing the whole file into one line. Only CSS gets that treatment: in JS a
   line ending in a comma is a statement, not a half-written value, and joining
   those would drag unrelated neighbours into one measurement and break the
   marker alignment the exceptions depend on. Each entry remembers the line it
   started on so an exception marker — which lives in a comment, on the line
   above or on the line itself — can still be found. */
export function logicalLines(code, isCss) {
  const out = [];
  let pending = null;
  let pendingLine = 0;
  const raw = code.split(/\r?\n/);
  for (let i = 0; i < raw.length; i += 1) {
    const line = raw[i].trim();
    if (pending !== null) {
      pending += ` ${line}`;
      const valueIsOpen = isCss && /,$/.test(line);
      if (!valueIsOpen || line.endsWith(";") || line.endsWith(")") || line.length === 0) {
        out.push({ line: pending, start: pendingLine });
        pending = null;
      }
      continue;
    }
    /* A declaration whose value starts on the next line ends in a bare colon. */
    if (/:\s*$/.test(line) && /[a-z-]+\s*:/.test(line) && !/[{;]/.test(line)) {
      pending = line;
      pendingLine = i;
      continue;
    }
    out.push({ line, start: i });
  }
  if (pending !== null) out.push({ line: pending, start: pendingLine });
  return out;
}

const COLOR_VALUE = /\b(?:rgba?|hsla?|lab|lch|oklch|oklab|color|color-mix|var|calc|env)\([^)]*\)/gi;
const LENGTH = /^-?(?:\d+\.?\d*|\.\d+)(px|rem|em|%)?$/;

/* box-shadow syntax is `[inset] x y [blur] [spread] [color]`, so a layer with a
   third length greater than zero is the soft shadow the design system forbids.
   Tailwind's arbitrary form uses underscores instead of spaces, and its named
   scale (shadow-sm … 2xl) is soft by definition. */
const SOFT_TAILWIND_SHADOW = /(?:^|[\s"'`:])(?:[a-z-]+:)*shadow-(?:xs|sm|md|lg|xl|2xl)(?=$|[\s"'`:]|\B)/g;

export function blurLengthsOf(layer) {
  const cleaned = layer
    .replace(COLOR_VALUE, " ")
    .replace(/#[0-9a-f]{3,8}\b/gi, " ")
    .replace(/\b(?:inset|currentcolor|transparent|none)\b/gi, " ")
    .replace(/_/g, " ");
  const lengths = cleaned.split(/\s+/).filter(token => LENGTH.test(token)).map(v => (v === "0" ? 0 : parseFloat(v)));
  return lengths[2] ?? 0;
}

export function splitTopLevel(value) {
  const parts = [];
  let depth = 0;
  let current = "";
  for (const char of value) {
    if (char === "(") depth += 1;
    if (char === ")") depth -= 1;
    if (char === "," && depth === 0) {
      parts.push(current);
      current = "";
      continue;
    }
    current += char;
  }
  parts.push(current);
  return parts.map(part => part.trim()).filter(Boolean);
}

export function countSoftShadow(line) {
  let total = 0;
  const named = line.match(SOFT_TAILWIND_SHADOW);
  if (named) total += named.length;
  const css = line.match(/(?:^|[\s;{])box-shadow\s*:\s*([^;]+)/g) ?? [];
  for (const declaration of css) {
    const value = declaration.slice(declaration.indexOf(":") + 1);
    for (const layer of splitTopLevel(value)) if (blurLengthsOf(layer) > 0) total += 1;
  }
  const arbitrary = line.match(/shadow-\[[^\]]+\]/g) ?? [];
  for (const token of arbitrary) {
    for (const layer of splitTopLevel(token.slice(8, -1))) if (blurLengthsOf(layer) > 0) total += 1;
  }
  return total;
}

/* A gradient used as a mask is geometry: `mask-image: linear-gradient(black 0 0)`
   paints nothing, it clips. Dropping the whole declaration before counting is what
   keeps a compliant 60-line mask from reading as 60 gradient violations — Tailwind
   carries the same thing as an arbitrary `[mask-image:…]` property, so both forms
   go. A `background:` that precedes the mask on the same line is left intact. */
export function stripMasks(line) {
  return line
    .replace(/\[[^\]]*\bmask[a-z-]*\s*:[^\]]*\]/gi, " ")
    .replace(/[-\w]*mask[-\w]*\s*:[^;}]*/gi, " ")
    /* Turning a banned feature off is not using it. */
    .replace(/(?:[-\w]*backdrop-filter|backdropFilter)\s*:\s*["']?none["']?/gi, " ");
}

const GRADIENT_FN = /(?:linear|radial|conic|repeating-linear|repeating-radial)-gradient\(/g;
export function countGradientPaint(line) {
  const hits = line.match(GRADIENT_FN);
  if (!hits) return 0;
  if (/\bshadow-\[|filter\s*:/.test(line) && !/background/i.test(line)) return 0;
  return hits.length;
}

export function hueOf(hex) {
  const digits = hex.slice(1);
  const full = digits.length === 3 ? digits.split("").map(c => c + c).join("") : digits.slice(0, 6);
  const r = parseInt(full.slice(0, 2), 16) / 255;
  const g = parseInt(full.slice(2, 4), 16) / 255;
  const b = parseInt(full.slice(4, 6), 16) / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const delta = max - min;
  if (!delta) return { hue: 0, saturation: 0 };
  let hue;
  if (max === r) hue = ((g - b) / delta) % 6;
  else if (max === g) hue = (b - r) / delta + 2;
  else hue = (r - g) / delta + 4;
  hue = Math.round(hue * 60);
  if (hue < 0) hue += 360;
  const lightness = (max + min) / 2;
  const saturation = delta / (1 - Math.abs(2 * lightness - 1) || 1);
  return { hue, saturation: saturation * 100 };
}

export const channels = parts => {
  const [r, g, b] = parts;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  if (!max || max === min) return { hue: 0, saturation: 0 };
  return hueOf(`#${[r, g, b].map(v => Math.round(v).toString(16).padStart(2, "0")).join("")}`);
};

/* Hue 190–280 at more than 10% saturation is the banned blue family. */
export const isBlue = ({ hue, saturation }) => hue >= 190 && hue <= 280 && saturation > 10;

/* Every banned thing a single measured line contains, with its match text so a
   guard failure can name what it found instead of only the rule it broke. */
export const MEASURED = [...Object.keys(PATTERNS), "gradientPaint", "softShadow", "blueHex", "blueRgb"];

export function measureLine(paint) {
  const found = [];
  const add = (name, hits) => {
    if (hits.length) found.push({ name, hits });
  };
  for (const [name, pattern] of Object.entries(PATTERNS)) add(name, paint.match(pattern) ?? []);
  /* countGradientPaint already applies the "is it actually paint?" test, so its
     verdict decides whether the matched functions are reported. */
  add("gradientPaint", countGradientPaint(paint) ? (paint.match(GRADIENT_FN) ?? []) : []);
  add("softShadow", Array.from({ length: countSoftShadow(paint) }, () => "box-shadow with a blur length"));
  add(
    "blueHex",
    (paint.match(HEX) ?? []).filter(hex => isBlue(hueOf(hex)))
  );
  add(
    "blueRgb",
    (paint.match(RGB) ?? [])
      .map(hit => hit.match(/[\d.]+/g))
      .filter(parts => parts && parts.length >= 3 && isBlue(channels(parts.slice(0, 3).map(Number))))
      .map(parts => `rgb(${parts.slice(0, 3).join(",")})`)
  );
  return found;
}

/* One pass over a file's source: what each line is, whether it carries an
   explicit exception, and what it paints. Both the census and the guards use it,
   so an exception can never be honoured by one and ignored by the other. */
export function findings(source, { isCss = false } = {}) {
  const { code, markers } = blankComments(source);
  const rows = [];
  for (const { line, start } of logicalLines(code, isCss)) {
    const marker = markers[start] ?? markers[start - 1];
    const hit = { line: start + 1, text: line, marker: marker ?? null };
    if (marker) {
      hit.found = [];
    } else {
      hit.found = line.trim() ? measureLine(stripMasks(line)) : [];
    }
    rows.push(hit);
  }
  return rows;
}

export function walk(dir, files = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, files);
    else if (EXTENSIONS.has(path.extname(entry.name))) files.push(full);
  }
  return files;
}

/* The reachability map is what keeps the guards honest about vendored source: a
   file nothing imports is not exempted by directory, it is exempted because it is
   not in the app — and importing it puts it straight back under the guard. */
export function reachability(root = process.cwd()) {
  const file = path.join(root, "qa/audit/reach.json");
  if (!fs.existsSync(file)) {
    throw new Error(`${file} is missing — run \`node qa/reach.mjs\` before the guards`);
  }
  return new Set(JSON.parse(fs.readFileSync(file, "utf8")).unreachable);
}
