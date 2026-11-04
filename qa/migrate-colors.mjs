/* Colour migration: rewrites every colour literal in the client stylesheets into
   a design-token reference declared in tokens.css.

     node qa/migrate-colors.mjs --check    # report what would change, write nothing
     node qa/migrate-colors.mjs            # rewrite in place

   Idempotent: tokens.css is skipped and the output holds no literals left to
   match. JavaScript/WebGL colour is not touched here — three.js needs concrete
   values, and those live in src/tokens.js, reviewed file by file rather than
   swept by a regex that cannot tell a material colour from a style string.

   The mapping is property-aware, not value-aware: the same grey hex is a border
   in one rule and body text in the next, and a pure value lookup turned the text
   into an invisible border colour. */
import fs from "node:fs";
import { pathToFileURL } from "node:url";
import path from "node:path";
import { fileURLToPath } from "node:url";

const clientRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
/* `--src=` retargets the sweep, which is how the mapping gets re-derived from the
   pre-migration snapshot instead of compounding on top of an earlier pass. */
const srcArg = process.argv.find(arg => arg.startsWith("--src="));
const srcRoot = srcArg ? path.resolve(clientRoot, srcArg.slice("--src=".length)) : path.join(clientRoot, "src");
const CHECK = process.argv.includes("--check");
const SKIP = new Set([path.join(srcRoot, "tokens.css"), path.join(srcRoot, "tokens.js")]);

/* ── colour parsing ─────────────────────────────────────────────────────────── */
const clamp255 = v => Math.max(0, Math.min(255, v));

function parseHex(text) {
  const body = text.slice(1);
  if (body.length === 3 || body.length === 4) {
    const [r, g, b, a] = [...body].map(ch => parseInt(ch + ch, 16));
    return { r, g, b, a: body.length === 4 ? a / 255 : undefined };
  }
  if (body.length === 6 || body.length === 8) {
    return {
      r: parseInt(body.slice(0, 2), 16),
      g: parseInt(body.slice(2, 4), 16),
      b: parseInt(body.slice(4, 6), 16),
      a: body.length === 8 ? parseInt(body.slice(6, 8), 16) / 255 : undefined
    };
  }
  return null;
}

function rgbToHsl(r, g, b) {
  const rn = r / 255;
  const gn = g / 255;
  const bn = b / 255;
  const max = Math.max(rn, gn, bn);
  const min = Math.min(rn, gn, bn);
  const l = (max + min) / 2;
  if (max === min) return { h: 0, s: 0, l };
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h;
  if (max === rn) h = (gn - bn) / d + (gn < bn ? 6 : 0);
  else if (max === gn) h = (bn - rn) / d + 2;
  else h = (rn - gn) / d + 4;
  return { h: (h / 6) * 360, s, l };
}

function parseColor(text) {
  const trimmed = text.trim();
  if (trimmed.startsWith("#")) return parseHex(trimmed);
  const fn = trimmed.match(/^rgba?\(([^)]*)\)$/i);
  if (!fn) return null;
  const parts = fn[1].split(/[,/\s]+/).filter(Boolean);
  if (parts.length < 3) return null;
  const num = (p, scale) => (p.endsWith("%") ? (parseFloat(p) / 100) * scale : parseFloat(p));
  const [r, g, b] = parts.slice(0, 3).map(p => num(p, 255));
  if ([r, g, b].some(n => Number.isNaN(n))) return null;
  const a = parts[3] === undefined ? undefined : clamp255(num(parts[3], 1)) / (parts[3].endsWith("%") ? 2.55 : 1);
  return { r: clamp255(r), g: clamp255(g), b: clamp255(b), a: parts[3] === undefined ? undefined : Math.max(0, Math.min(1, a)) };
}

const COOL = h => h >= 185 && h <= 335;
export const COLOR_RE = /#[0-9a-fA-F]{3,8}\b|rgba?\([^()]*\)/g;
const describe = color => {
  const { h, s, l } = rgbToHsl(color.r, color.g, color.b);
  return { h, s, l, a: color.a };
};

/* ── token mapping ──────────────────────────────────────────────────────────── */
const tint = (token, alpha) =>
  `color-mix(in srgb, var(--${token}) ${Math.max(2, Math.round(alpha * 100))}%, transparent)`;

/* A dark neutral's place in the surface ladder, shared by every role that paints
   a plane rather than a line or a glyph. */
function surfaceFor(l) {
  if (l < 0.13) return "var(--bg)";
  if (l < 0.22) return "var(--surface)";
  if (l < 0.36) return "var(--surface-2)";
  if (l < 0.52) return "var(--border)";
  if (l < 0.7) return "var(--border-strong)";
  return "var(--text)";
}

/* A translucent dark wash (a dialog scrim, a sticky bar over content) reads as
   the page colour with its alpha lowered. Left as a `--slab` tint it turns to
   ink in the light theme; mapped to `--bg` it stays the surface it covered. */
const isDarkScrim = (l, alpha) => alpha < 1 && alpha >= 0.35 && l < 0.3;

export function mapColor(raw, role) {
  const color = parseColor(raw);
  if (!color) return raw;
  const { h, s, l } = describe(color);
  const alpha = color.a === undefined ? 1 : color.a;
  const translucent = alpha < 1;
  const cool = COOL(h) && s > 0.1;
  const neutral = s <= 0.14;

  if (neutral) {
    if (l <= 0.05) return translucent ? tint("slab", alpha) : "var(--slab)";
    if (translucent && l > 0.6) return tint("text", alpha);
    if (translucent && isDarkScrim(l, alpha) && role === "bg") return tint("bg", alpha);
    if (translucent && l <= 0.6) return tint("slab", alpha);
    if (role === "border") return l < 0.5 ? "var(--border)" : "var(--border-strong)";
    if (l >= 0.93) return "var(--text)";
    if (role === "text" || role === "svg") {
      if (l < 0.25) return "var(--on-accent)";
      return l < 0.62 ? "var(--muted)" : "var(--text)";
    }
    return surfaceFor(l);
  }

  if (cool) {
    /* Almost-black cool values were the ink painted on top of a filled accent
       chip, not a colour in its own right. */
    if (role === "text") {
      if (l < 0.22) return "var(--on-accent)";
      if (l >= 0.8) return "var(--text)";
      if (s > 0.55 && l >= 0.4) return translucent ? tint("accent", alpha) : "var(--accent-text)";
      if (l >= 0.62) return translucent ? tint("text", alpha) : "var(--muted)";
      return "var(--muted)";
    }
    /* A saturated blue line was always the accent doing emphasis work, so it
       keeps the accent at every alpha instead of falling back to the neutral
       hairline and losing the signal. */
    if (role === "border") {
      if (s > 0.3) {
        if (translucent) return tint("accent", alpha);
        return l >= 0.35 ? "var(--accent)" : "var(--border-strong)";
      }
      return l < 0.5 ? "var(--border)" : "var(--border-strong)";
    }
    if (role === "svg") {
      if (l < 0.22) return "var(--on-accent)";
      if (s > 0.35) return translucent ? tint("accent", alpha) : "var(--accent)";
      return l > 0.7 ? "var(--text)" : "var(--muted)";
    }
    /* Surfaces last, and lightness outranks saturation: `rgba(13,21,36,.72)` is
       a saturated navy, but it is a scrim you read through, not an accent you
       read on. Only a mid-lightness blue was ever the brand colour. */
    if (translucent && l < 0.3) return tint("bg", alpha);
    if (translucent && s > 0.3) return tint("accent", alpha);
    if (translucent) return l > 0.6 ? tint("text", alpha) : tint("slab", alpha);
    if (l < 0.3) return surfaceFor(l);
    if (s > 0.3) return l <= 0.82 ? "var(--accent)" : "var(--text)";
    if (l >= 0.78) return "var(--text)";
    if (l >= 0.55) return "var(--muted)";
    return surfaceFor(l);
  }

  /* Warm hues keep their meaning: orange is the accent, amber the warning, red
     the error, green the ok. The 38° cut is where the accent family stops and
     the warning family starts. */
  if (h < 15 || h >= 335) return translucent ? tint("error", alpha) : "var(--error)";
  if (h < 38) return translucent ? tint("accent", alpha) : "var(--accent)";
  if (h < 70) return translucent ? tint("warn", alpha) : "var(--warn)";
  if (h < 185) return translucent ? tint("ok", alpha) : "var(--ok)";
  return translucent ? tint("accent", alpha) : "var(--accent)";
}

/* ── value surgery ──────────────────────────────────────────────────────────── */
function splitTopLevel(value, sep = ",") {
  const out = [];
  let depth = 0;
  let current = "";
  for (const ch of value) {
    if (ch === "(") depth += 1;
    if (ch === ")") depth -= 1;
    if (ch === sep && depth === 0) {
      out.push(current);
      current = "";
      continue;
    }
    current += ch;
  }
  out.push(current);
  return out;
}

const replaceColors = (value, role) => value.replace(COLOR_RE, match => mapColor(match, role));

/* Gradients are banned outright, so a painted plane loses the ramp and keeps its
   dominant surface: the stop lightness decides which rung of the ladder. Once the
   literals have been replaced by tokens, lightness is no longer readable, so a
   ramp whose stops are all token references is classified by the names it uses. */
function flattenGradient(value) {
  const stops = (value.match(COLOR_RE) ?? []).map(parseColor).filter(Boolean);
  const names = value.match(/var\(--[^,) \n]+/g) ?? [];
  if (!stops.length) {
    if (names.some(name => /line|border|divider|rule/.test(name))) return "var(--border)";
    if (names.some(name => /accent/.test(name))) return "var(--accent)";
    return "var(--surface)";
  }
  const stats = stops.map(describe);
  const avgL = stats.reduce((sum, c) => sum + c.l, 0) / stats.length;
  const accentStops = stats.filter(c => COOL(c.h) && c.s > 0.4).length;
  if (accentStops >= 2 && avgL > 0.4) return "var(--accent)";
  if (avgL < 0.2) return "var(--bg)";
  if (avgL < 0.4) return "var(--surface)";
  if (avgL < 0.62) return "var(--surface-2)";
  return "color-mix(in srgb, var(--text) 3%, transparent)";
}

/* Masks are geometry, not paint: they have to keep working in both themes, so
   the literals inside them become the black/white keywords rather than tokens. */
function keywordsForMask(value) {
  return value.replace(COLOR_RE, match => {
    const color = parseColor(match);
    if (!color) return match;
    const { l } = describe(color);
    if (color.a !== undefined && color.a < 0.5) return "transparent";
    return l > 0.5 ? "white" : "black";
  });
}

const pxList = layer => (layer.match(/-?\d*\.?\d+(px|rem|em)?(?=\s|$)/g) ?? [])
  .map(token => parseFloat(token))
  .filter(n => !Number.isNaN(n));

/* `filter: drop-shadow(0 0 12px …)` is the other half of the glow that lived in
   box-shadow, and the blue in it survived the first sweep because the filter
   branch returned before the colour pass. A drop-shadow is kept only when its
   blur is zero, i.e. when it is a hard offset. */
function migrateFilter(value) {
  const layers = splitTopLevel(value, " ")
    .map(layer => layer.trim())
    .filter(Boolean)
    .filter(fn => !/^(-webkit-)?blur\(/.test(fn))
    .map(fn => {
      const inner = fn.match(/^(-webkit-)?drop-shadow\((.*)\)$/);
      if (!inner) return fn;
      const numbers = pxList(inner[2]);
      if (numbers.length >= 3 && Math.abs(numbers[2]) > 0) return null;
      return `drop-shadow(${replaceColors(inner[2], "slab")})`;
    })
    .filter(Boolean);
  return layers.length ? layers.join(" ") : "none";
}

function migrateShadow(value) {
  const kept = splitTopLevel(value)
    .map(layer => layer.trim())
    .filter(Boolean)
    .filter(layer => {
      const numbers = pxList(layer);
      const inset = /inset/.test(layer);
      const blur = numbers.length >= 3 ? Math.abs(numbers[2]) : 0;
      if (blur > 0 && !inset) return false;
      /* `0 0 0 45px …` has no offset and no blur: it is a painted ring, and every
         ring in this product was a glow. */
      if (!inset && numbers.length >= 3 && numbers[0] === 0 && numbers[1] === 0 && numbers[2] === 0) return false;
      return true;
    })
    .map(layer =>
      /* An inset layer carries a physical meaning (the edge of a well), so it
         stays — but its blur is shaved to 0, because no shadow in this product
         is allowed to be soft. */
      /inset/.test(layer)
        ? layer.replace(/^((?:inset\s+)?-?\d*\.?\d+px\s+-?\d*\.?\d+px\s+)-?\d*\.?\d+px/, "$10px")
        : layer
    );
  if (!kept.length) return "none";
  return kept.map(layer => replaceColors(layer, "border")).join(", ");
}

const BG_PROPS = new Set(["background", "background-color", "background-image"]);
const TEXT_PROPS = new Set(["color", "caret-color", "-webkit-text-fill-color"]);
const BORDER_PROPS = new Set([
  "border",
  "border-top",
  "border-right",
  "border-bottom",
  "border-left",
  "border-block",
  "border-inline",
  "outline",
  "outline-color",
  "column-rule",
  "text-decoration-color",
  "scrollbar-color"
]);
const SVG_PROPS = new Set(["fill", "stroke", "stop-color", "flood-color", "lighting-color"]);
const MASK_PROPS = new Set(["mask-image", "-webkit-mask-image", "mask", "-webkit-mask"]);

export function roleFor(prop) {
  const p = prop.toLowerCase();
  if (BG_PROPS.has(p)) return "bg";
  if (TEXT_PROPS.has(p)) return "text";
  if (BORDER_PROPS.has(p)) return "border";
  if (SVG_PROPS.has(p)) return "svg";
  if (MASK_PROPS.has(p)) return "mask";
  /* A page-local custom property still declares an intent, and the name is the
     only place it is written down: `--combo-line` is a rule, not a plane. */
  if (p.startsWith("--")) {
    if (/text|ink|fg|foreground|copy/.test(p)) return "text";
    if (/line|border|rule|divider|edge/.test(p)) return "border";
    if (/bg|surface|panel|card|fill|raised|shell/.test(p)) return "bg";
  }
  return "generic";
}

function migrateDeclaration(prop, value) {
  const p = prop.toLowerCase();
  if (p === "backdrop-filter" || p === "-webkit-backdrop-filter") return null;

  if (p === "box-shadow" || p === "-webkit-box-shadow") return [prop, migrateShadow(value)];

  if (p === "text-shadow") {
    const layers = splitTopLevel(value).filter(layer => {
      const numbers = pxList(layer);
      return !(numbers.length >= 3 && Math.abs(numbers[2]) > 0);
    });
    return layers.length
      ? [prop, layers.map(layer => replaceColors(layer, "border")).join(", ")]
      : [prop, "none"];
  }

  if (p === "filter" || p === "-webkit-filter") return [prop, migrateFilter(value)];

  const role = roleFor(p);
  /* A token reference with a hex fallback keeps its fallback, retinted to a
     token: dropping it outright would make the property invalid if the name was
     never defined. `var(--accent, var(--accent))` is the one form that is pure
     noise, so that collapses. */
  let next = value.replace(/var\((--[^,)]+),\s*(#[0-9a-fA-F]{3,8}|rgba?\([^)]*\))\)/g, (match, name, fallback) => {
    const mapped = mapColor(fallback, role);
    return mapped === `var(${name})` ? `var(${name})` : `var(${name}, ${mapped})`;
  });
  if (role === "mask") next = keywordsForMask(next);
  else if (/-gradient\(/.test(next) && (role === "bg" || role === "generic")) next = flattenGradient(next);
  else next = replaceColors(next, role);

  if (p === "letter-spacing") {
    if (/em$/.test(next) && parseFloat(next) < -0.02) return [prop, "-0.02em"];
    if (/px$/.test(next) && parseFloat(next) < -0.3) return [prop, "-0.3px"];
  }

  if (p === "font-family" || p === "font" || p === "font-weight") {
    next = next
      .replace(/'Outfit'/g, "var(--font-sans)")
      .replace(/"Outfit"/g, "var(--font-sans)")
      .replace(/'DM Mono'/g, "var(--font-mono)")
      .replace(/"DM Mono"/g, "var(--font-mono)")
      .replace(/'Instrument Serif'/g, "var(--font-display)")
      .replace(/"Instrument Serif"/g, "var(--font-display)");
    next = next.replace(/,?\s*system-ui\s*,\s*-apple-system\s*,\s*"Segoe UI"\s*,\s*sans-serif/g, "");
    if (p === "font-weight") next = next.replace(/\b(7\d\d|8\d\d|9\d\d)\b/, "600");
  }

  return [prop, next];
}

/* Walks declarations without a full CSS parser: a declaration runs to the next
   `;`, `{` or `}`, which holds for this codebase because no value contains a
   block. Comments are copied through untouched so the scanner never rewrites a
   hex that only appears in prose. */
function migrateCss(source) {
  const out = [];
  const changes = [];
  let i = 0;
  /* Prelude guard: `@supports (-webkit-backdrop-filter: blur(2px))` contains a
     text that looks exactly like a declaration, and deleting it would destroy
     the at-rule. Only match declarations at parenthesis depth zero. */
  let depth = 0;
  while (i < source.length) {
    const ch = source[i];

    if (ch === "/" && source[i + 1] === "*") {
      const end = source.indexOf("*/", i + 2);
      const stop = end < 0 ? source.length : end + 2;
      out.push(source.slice(i, stop));
      i = stop;
      continue;
    }
    if (ch === "(") {
      depth += 1;
      out.push(ch);
      i += 1;
      continue;
    }
    if (ch === ")" && depth > 0) {
      depth -= 1;
      out.push(ch);
      i += 1;
      continue;
    }
    if (ch === "{") {
      out.push(ch);
      i += 1;
      continue;
    }

    /* A declaration only if a colon precedes any ; { } from here. */
    const valueEnd = (() => {
      const semi = source.indexOf(";", i);
      const open = source.indexOf("{", i);
      const close = source.indexOf("}", i);
      return Math.min(
        semi < 0 ? Infinity : semi,
        open < 0 ? Infinity : open,
        close < 0 ? Infinity : close
      );
    })();
    const chunk = source.slice(i, valueEnd);
    /* An optional vendor dash, never a required one: an earlier revision demanded
       a leading `-` and silently skipped every unprefixed declaration. */
    const head = depth === 0 ? chunk.match(/^(\s*)(-{0,2}[a-zA-Z][-a-zA-Z0-9]*)((?:\s*:\s*).*)$/s) : null;
    if (!head) {
      out.push(ch);
      i += 1;
      continue;
    }

    const [, indent, prop, rest] = head;
    const separator = rest.match(/^\s*:\s*/)?.[0] ?? ":";
    const rawValue = rest.slice(separator.length);
    const trailing = rawValue.match(/\s*$/)?.[0] ?? "";
    const result = migrateDeclaration(prop, rawValue.trim());
    if (result === null) {
      changes.push(`${prop}: removed`);
      i = valueEnd + 1;
      continue;
    }
    const rendered = `${indent}${result[0]}${separator}${result[1]}${trailing}`;
    if (rendered !== chunk) changes.push(`${prop}: ${rawValue.trim()} -> ${result[1]}`);
    out.push(rendered);
    i = valueEnd;
  }
  return { text: out.join(""), changes };
}

function walk(dir) {
  const files = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) files.push(...walk(full));
    else if (entry.name.endsWith(".css")) files.push(full);
  }
  return files;
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;

if (isMain) {
let totalFiles = 0;
let totalChanges = 0;
for (const file of walk(srcRoot)) {
  if (SKIP.has(file)) continue;
  const source = fs.readFileSync(file, "utf8");
  const { text, changes } = migrateCss(source);
  if (!changes.length) continue;
  totalFiles += 1;
  totalChanges += changes.length;
  console.log(`${String(changes.length).padStart(4)}  ${path.relative(srcRoot, file)}`);
  if (CHECK) {
    for (const line of changes.slice(0, 6)) console.log(`        ${line}`);
  } else {
    fs.writeFileSync(file, text);
  }
}
console.log(`${CHECK ? "would rewrite" : "rewritten"}: ${totalFiles} files, ${totalChanges} declarations`);
}
