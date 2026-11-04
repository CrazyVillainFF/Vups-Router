import { paletteFor, token } from "../../tokens.js";
import * as THREE from "three";

/* Text in the scene is drawn, never downloaded.

   A provider label has to be legible at the size the constellation puts it on
   screen, and an HTML overlay projected onto a moving 3D point drifts the
   moment the camera eases. So the label is a canvas texture on a plane: it
   shares the scene's depth, its lighting-independent ink, and its lifecycle —
   and it is released with the mesh that used it. */

const FONT_STACK = '"Geist Mono", ui-monospace, monospace';
const PIXEL_RATIO = 2;
const GLYPH_PX = 13;
const PAD_X = 14;
const PAD_Y = 10;
const FONT = `500 ${GLYPH_PX * PIXEL_RATIO}px ${FONT_STACK}`;

const cache = new Map();

let scratch;

/** The box a name would occupy, in CSS pixels. Measured with the same font and
    padding as `drawLabel` below, so a name that is never drawn can still hold
    its place in the ring's collision maths. */
export function labelSize(value) {
  if (!scratch) scratch = document.createElement("canvas").getContext("2d");
  scratch.font = FONT;
  const text = String(value ?? "").trim();
  return {
    width: Math.max(24, Math.round(scratch.measureText(text).width / PIXEL_RATIO) + PAD_X * 2),
    height: GLYPH_PX + PAD_Y * 2
  };
}

function drawLabel(value, palette) {
  const { width, height } = labelSize(value);
  const canvas = document.createElement("canvas");
  const ctx = canvas.getContext("2d");
  canvas.width = Math.round(width * PIXEL_RATIO);
  canvas.height = Math.round(height * PIXEL_RATIO);

  // Resizing the canvas resets the 2D context, so the font is set again here.
  ctx.font = FONT;
  ctx.textBaseline = "middle";
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = token("text", palette);
  ctx.fillText(String(value ?? "").trim(), PAD_X * PIXEL_RATIO, canvas.height / 2);

  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = 4;
  texture.minFilter = THREE.LinearFilter;
  texture.generateMipmaps = false;
  return { texture, width, height };
}

export function labelTexture(value, theme = "dark") {
  const key = `${value}::${theme}`;
  const hit = cache.get(key);
  if (hit) {
    hit.refs += 1;
    return hit;
  }
  // The palette is passed explicitly rather than read from the document, so a
  // label built for the dark stage cannot be handed to the light one by accident.
  const entry = { ...drawLabel(value, paletteFor(theme)), refs: 1 };
  cache.set(key, entry);
  return entry;
}

export function releaseLabel(value, theme = "dark") {
  const key = `${value}::${theme}`;
  const hit = cache.get(key);
  if (!hit) return;
  hit.refs -= 1;
  if (hit.refs > 0) return;
  hit.texture.dispose();
  cache.delete(key);
}

export function disposeLabels() {
  for (const entry of cache.values()) entry.texture.dispose();
  cache.clear();
}

export function cachedLabelCount() {
  return cache.size;
}
