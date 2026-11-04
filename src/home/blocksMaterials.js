import { token, mix } from "../tokens.js";
import * as THREE from "three";

// Everything the clay blocks need is generated in-process: a procedural equirect
// studio for the reflections, and two canvases per model name (one relief, one
// ink) turned into textures. No bitmap is fetched, no HDRI is downloaded, so the
// scene renders identically offline and in the packaged desktop shell.

export const CLAY_DARK = {
  body: token("surface"),
  alt: token("surface"),
  // A groove catches the key light on its upper edge, so the shadow sits above
  // the letter and the chalk-bright face of it reads at arm's length.
  label: token("warn"),
  bevel: mix("slab", 0.6)
};

export const CLAY_LIGHT = {
  body: token("warn"),
  alt: token("warn"),
  label: token("accent"),
  bevel: mix("text", 0.85)
};

export function clayFor(theme) {
  return theme === "light" ? CLAY_LIGHT : CLAY_DARK;
}

// The 3D layer reads the same two palettes the CSS tokens declare, but it cannot
// use a CSS variable, so the hexes are stated here once and kept in step by
// blocks.test.js.
export function paletteFor(theme = "dark") {
  const clay = clayFor(theme);
  return theme === "light"
    ? {
        theme: "light",
        clay: clay.body,
        clayAlt: clay.alt,
        floor: token("warn"),
        shadow: token("surface-2"),
        key: token("warn"),
        fill: token("warn"),
        accent: token("accent")
      }
    : {
        theme: "dark",
        clay: clay.body,
        clayAlt: clay.alt,
        floor: token("bg"),
        shadow: token("slab"),
        key: token("accent"),
        fill: token("surface-2"),
        accent: token("accent")
      };
}

export function studioCanvas(theme = "dark") {
  const canvas = document.createElement("canvas");
  canvas.width = 256;
  canvas.height = 128;
  const ctx = canvas.getContext("2d");
  if (!ctx) return canvas;
  const warm = theme === "light";
  const sky = ctx.createLinearGradient(0, 0, 0, canvas.height);
  sky.addColorStop(0, warm ? token("text") : token("warn"));
  sky.addColorStop(0.5, warm ? token("warn") : token("warn"));
  sky.addColorStop(1, warm ? token("warn") : token("warn"));
  ctx.fillStyle = sky;
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  // Two soft boxes: the key from upper left, a low bounce from the floor.
  const lights = warm
    ? [
        { at: [0.26, 0.2], radius: 0.34, color: mix("text", 0.95) },
        { at: [0.72, 0.66], radius: 0.3, color: mix("accent", 0.5) }
      ]
    : [
        { at: [0.26, 0.2], radius: 0.32, color: mix("accent", 0.7) },
        { at: [0.72, 0.66], radius: 0.28, color: mix("accent", 0.28) }
      ];
  for (const stop of lights) {
    const x = stop.at[0] * canvas.width;
    const y = stop.at[1] * canvas.height;
    const radius = stop.radius * canvas.width;
    const glow = ctx.createRadialGradient(x, y, 0, x, y, radius);
    glow.addColorStop(0, stop.color);
    glow.addColorStop(1, mix("slab", 0.02));
    ctx.fillStyle = glow;
    ctx.fillRect(0, 0, canvas.width, canvas.height);
  }
  return canvas;
}

const FACE_FONT = '"Geist Mono", "DM Mono", ui-monospace, monospace';
const FACE_MAX_FONT = 40;
const FACE_MIN_FONT = 16;
const FACE_MAX_LINES = 3;

// Break a run of glyphs at the measured width. Model ids are one long token
// ("nvidia/nemotron-3.5-lightning"), and a wrapper that only splits on spaces
// hands the canvas a word wider than the plate, which centre-draws with both
// ends falling off the bitmap.
function breakToken(ctx, word, maxWidth) {
  const chunks = [];
  let chunk = "";
  for (const char of word) {
    if (chunk && ctx.measureText(chunk + char).width > maxWidth) {
      chunks.push(chunk);
      chunk = char;
    } else {
      chunk += char;
    }
  }
  if (chunk) chunks.push(chunk);
  return chunks;
}

// Returns every line the text needs at the current font size. The caller counts
// them to decide whether the size fits; capping here is what made the old shrink
// loop unreachable, because a capped list can never exceed its own cap.
function layoutLines(ctx, value, maxWidth) {
  const words = String(value || "").split(/\s+/).filter(Boolean);
  const lines = [];
  let line = "";
  const flush = () => {
    if (line) {
      lines.push(line);
      line = "";
    }
  };
  for (const word of words) {
    const joined = line ? `${line} ${word}` : word;
    if (ctx.measureText(joined).width <= maxWidth) {
      line = joined;
      continue;
    }
    flush();
    if (ctx.measureText(word).width <= maxWidth) {
      line = word;
      continue;
    }
    const chunks = breakToken(ctx, word, maxWidth);
    line = chunks.pop() ?? word;
    for (const chunk of chunks) lines.push(chunk);
  }
  flush();
  return lines;
}

// Shorten one line until the ellipsis it needs still fits the plate.
function clampLine(ctx, line, maxWidth) {
  if (ctx.measureText(line).width <= maxWidth) return line;
  let text = line;
  while (text.length > 1 && ctx.measureText(`${text}\u2026`).width > maxWidth) {
    text = text.slice(0, -1);
  }
  return `${text}\u2026`;
}

function fitFace(ctx, name, maxWidth) {
  for (let size = FACE_MAX_FONT; size >= FACE_MIN_FONT; size -= 2) {
    ctx.font = `500 ${size}px ${FACE_FONT}`;
    const lines = layoutLines(ctx, name, maxWidth);
    if (lines.length <= FACE_MAX_LINES) return { fontSize: size, lines };
  }
  ctx.font = `500 ${FACE_MIN_FONT}px ${FACE_FONT}`;
  const lines = layoutLines(ctx, name, maxWidth).slice(0, FACE_MAX_LINES);
  return { fontSize: FACE_MIN_FONT, lines: lines.map(line => clampLine(ctx, line, maxWidth)) };
}

// The face label is the model's display name, auto-fitted: the font shrinks
// until the whole name sits inside the plate, and only the final fallback
// abbreviates. A label that overflows is worse than a small one, and a label
// that misreads as a different model is worse than either.
function drawFace(name, tone) {
  const size = 256;
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext("2d");
  if (!ctx) return { relief: canvas, ink: canvas };

  const relief = document.createElement("canvas");
  relief.width = size;
  relief.height = size;
  const reliefCtx = relief.getContext("2d");

  const maxWidth = size * 0.66;
  const { fontSize, lines } = fitFace(ctx, name, maxWidth);

  const lineHeight = fontSize * 1.16;
  const startY = size / 2 - ((lines.length - 1) * lineHeight) / 2;

  reliefCtx.fillStyle = token("text");
  reliefCtx.fillRect(0, 0, size, size);
  reliefCtx.font = `500 ${fontSize}px ${FACE_FONT}`;
  reliefCtx.textAlign = "center";
  reliefCtx.textBaseline = "middle";
  reliefCtx.fillStyle = token("slab");
  lines.forEach((line, index) => {
    reliefCtx.fillText(line, size / 2, startY + index * lineHeight);
  });

  ctx.clearRect(0, 0, size, size);
  ctx.font = `500 ${fontSize}px ${FACE_FONT}`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  lines.forEach((line, index) => {
    const y = startY + index * lineHeight;
    ctx.fillStyle = tone.bevel;
    ctx.fillText(line, size / 2, y - 1.6);
    ctx.fillStyle = tone.label;
    ctx.fillText(line, size / 2, y + 0.6);
  });

  return { relief, ink: canvas };
}

const textureCache = new Map();

export function faceTextures(name, theme = "dark") {
  const clay = clayFor(theme);
  const key = `${theme}::${name}`;
  const cached = textureCache.get(key);
  if (cached) return cached;
  const { relief, ink } = drawFace(name, { label: clay.label, bevel: clay.bevel });
  const reliefTexture = new THREE.CanvasTexture(relief);
  const inkTexture = new THREE.CanvasTexture(ink);
  for (const texture of [reliefTexture, inkTexture]) {
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.anisotropy = 4;
  }
  const entry = { relief: reliefTexture, ink: inkTexture };
  textureCache.set(key, entry);
  return entry;
}

export function releaseFace(name, theme = "dark") {
  const key = `${theme}::${name}`;
  const entry = textureCache.get(key);
  if (!entry) return;
  entry.relief.dispose();
  entry.ink.dispose();
  textureCache.delete(key);
}

export function disposeFaces() {
  for (const entry of textureCache.values()) {
    entry.relief.dispose();
    entry.ink.dispose();
  }
  textureCache.clear();
}

export function cachedFaceCount() {
  return textureCache.size;
}
