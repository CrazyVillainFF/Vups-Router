/* ── VupsRouter design tokens: the JavaScript mirror ───────────────────────────
   WebGL materials and canvas-2D textures cannot resolve a CSS custom property,
   so the same palette is restated here. This is the only JS file allowed to
   contain a raw colour literal, and qa/guard-no-hex.mjs pairs it with a check
   that every value below also appears in tokens.css — the two lists cannot
   drift apart without failing the guard. */

export const DARK = {
  bg: "#0f0e0c",
  surface: "#171613",
  surface2: "#1f1d19",
  border: "#2a2824",
  borderStrong: "#3a3732",
  text: "#edeae3",
  muted: "#8f8b82",
  faint: "#5c5851",
  accent: "#ff5b1f",
  accentPress: "#e04a12",
  onAccent: "#171613",
  ok: "#9bd770",
  warn: "#e8b04a",
  error: "#e5584a",
  accentText: "#ff5b1f",
  slab: "#000000",

  /* 3D materials. Clay is the border colour standing in for a physical block;
     key/fill are the studio lights, not surfaces, so they sit outside the CSS
     list and are checked against the token file by name, not by value. */
  clay: "#2a2824",
  clayAlt: "#3a3732",
  clayLabel: "#edeae3",
  floor: "#171613",
  shadow: "#000000",
  key: "#fff4e2",
  fill: "#4a4238"
};

export const LIGHT = {
  bg: "#f4f1ea",
  surface: "#fbf9f4",
  surface2: "#f0ece2",
  border: "#ddd8cc",
  borderStrong: "#c9c3b4",
  text: "#171613",
  muted: "#6b665c",
  faint: "#b4ae9f",
  accent: "#ff5b1f",
  accentPress: "#d94a13",
  onAccent: "#171613",
  ok: "#3f7a1e",
  warn: "#8a5a00",
  error: "#b3261e",
  slab: "#2a2015",
  accentText: "#c73e0a",

  clay: "#c9c3b4",
  clayAlt: "#b4ae9f",
  clayLabel: "#171613",
  floor: "#f0ece2",
  shadow: "#8c8474",
  key: "#fffdf8",
  fill: "#e3dbcb"
};

export const PALETTES = { dark: DARK, light: LIGHT };

export function paletteFor(theme = "dark") {
  return PALETTES[theme === "light" ? "light" : "dark"];
}

/* Names are spelled the CSS way at the call site (`surface-2`, `on-accent`) so a
   canvas colour and a stylesheet colour read identically in review. */
const JS_KEYS = {
  "surface-2": "surface2",
  "border-strong": "borderStrong",
  "accent-press": "accentPress",
  "accent-text": "accentText",
  "on-accent": "onAccent"
};

function keyFor(name) {
  return JS_KEYS[name] ?? name.replace(/-(\w)/g, (_, c) => c.toUpperCase());
}

/* The theme is whatever the shell resolved, not what this module assumed at
   import time: a canvas drawn before the switch would otherwise keep painting
   the old palette for the life of the page. */
export function currentTheme(globalThisRef = typeof window === "undefined" ? null : window) {
  const attr = globalThisRef?.document?.documentElement?.dataset?.theme;
  if (attr === "light" || attr === "dark") return attr;
  return "dark";
}

export function currentPalette(globalThisRef = typeof window === "undefined" ? null : window) {
  return paletteFor(currentTheme(globalThisRef));
}

export function token(name, palette = currentPalette()) {
  return palette[keyFor(name)] ?? palette.bg;
}

function toRgba(hex) {
  const body = hex.slice(1);
  const full = body.length === 3 ? [...body].map(c => c + c).join("") : body.slice(0, 6);
  const [r, g, b] = [0, 2, 4].map(i => parseInt(full.slice(i, i + 2), 16));
  return [r, g, b];
}

/* Canvas and WebGL have no color-mix(), so a tint is computed here — still from
   a palette value, never from a literal at the call site. */
export function mix(name, alpha, palette = currentPalette()) {
  const [r, g, b] = toRgba(token(name, palette));
  return `rgba(${r}, ${g}, ${b}, ${Math.max(0, Math.min(1, alpha))})`;
}

export const FONTS = {
  display: '"Instrument Serif", Georgia, serif',
  sans: '"Geist", system-ui, sans-serif',
  mono: '"Geist Mono", ui-monospace, monospace'
};
