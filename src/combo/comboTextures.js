import { token, mix } from "../tokens.js";
import * as THREE from "three";

// Turns the same authentic artwork the 2D layer uses into GPU textures. The
// bundled provider marks are single-colour silhouettes, so they are rasterised
// as a mask and tinted with the brand colour - exactly what combo.css does with
// mask-image. Nothing here draws an invented logo.

const CACHE = new Map();
const TEXTURE_SIZE = 128;
const LOGO_BOX = 96;
const LOGO_PAD = 8;

export function fitRect(sourceWidth, sourceHeight, boxSize) {
  const sw = Math.max(1, Number(sourceWidth) || 1);
  const sh = Math.max(1, Number(sourceHeight) || 1);
  const box = Math.max(1, Number(boxSize) || LOGO_BOX);
  const scale = Math.min(box / sw, box / sh);
  const width = Math.max(1, Math.round(sw * scale));
  const height = Math.max(1, Math.round(sh * scale));
  return { x: Math.round((box - width) / 2), y: Math.round((box - height) / 2), width, height };
}

export function textureKey(art) {
  if (!art) return null;
  if (art.type === "logo" || art.type === "image") return `${art.type}:${art.src}`;
  if (art.type === "wordmark") return `wordmark:${art.wordmark || art.name}:${art.color}`;
  return null;
}

function makeCanvas(size) {
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  return canvas;
}

function loadImage(src) {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.crossOrigin = "anonymous";
    image.decoding = "async";
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error(`Could not load ${src}`));
    image.src = src;
  });
}

function tintedMask(image, color) {
  const canvas = makeCanvas(TEXTURE_SIZE);
  const ctx = canvas.getContext("2d");
  if (!ctx) return canvas;
  const box = { x: (TEXTURE_SIZE - LOGO_BOX) / 2, y: (TEXTURE_SIZE - LOGO_BOX) / 2 };
  const rect = fitRect(image.naturalWidth || 24, image.naturalHeight || 24, LOGO_BOX - LOGO_PAD);
  ctx.drawImage(image, box.x + rect.x, box.y + rect.y, rect.width, rect.height);
  ctx.globalCompositeOperation = "source-in";
  ctx.fillStyle = color || token("text");
  ctx.fillRect(0, 0, TEXTURE_SIZE, TEXTURE_SIZE);
  ctx.globalCompositeOperation = "source-over";
  return canvas;
}

function rawImage(image) {
  const canvas = makeCanvas(TEXTURE_SIZE);
  const ctx = canvas.getContext("2d");
  if (!ctx) return canvas;
  const rect = fitRect(image.naturalWidth || 1, image.naturalHeight || 1, LOGO_BOX);
  ctx.drawImage(image, (TEXTURE_SIZE - LOGO_BOX) / 2 + rect.x, (TEXTURE_SIZE - LOGO_BOX) / 2 + rect.y, rect.width, rect.height);
  return canvas;
}

export function wordmarkCanvas(wordmark, color, size = TEXTURE_SIZE) {
  const canvas = makeCanvas(size);
  const ctx = canvas.getContext("2d");
  if (!ctx) return canvas;
  const text = String(wordmark || "").trim() || "Model";
  let fontSize = Math.round(size * 0.2);
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.font = `600 ${fontSize}px "Segoe UI", system-ui, sans-serif`;
  while (ctx.measureText(text).width > size * 0.78 && fontSize > 9) {
    fontSize -= 1;
    ctx.font = `600 ${fontSize}px "Segoe UI", system-ui, sans-serif`;
  }
  ctx.fillStyle = color || token("text");
  ctx.fillText(text, size / 2, size / 2);
  return canvas;
}

function finish(canvas) {
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = 4;
  texture.needsUpdate = true;
  return texture;
}

// Returns a promise so the caller can hold the mesh back until the mark exists;
// a failed load resolves to null and the node keeps its housing, never a fake logo.
export async function acquireMarkTexture(art) {
  const key = textureKey(art);
  if (!key) return null;
  if (CACHE.has(key)) return CACHE.get(key);
  if (typeof document === "undefined") return null;

  let texture = null;
  if (art.type === "wordmark") {
    texture = finish(wordmarkCanvas(art.wordmark, art.color));
  } else if (art.src) {
    try {
      const image = await loadImage(art.src);
      texture = finish(art.type === "logo" ? tintedMask(image, art.color) : rawImage(image));
    } catch {
      texture = finish(wordmarkCanvas(art.name || art.wordmark, art.color));
    }
  }
  if (!texture) return null;
  CACHE.set(key, texture);
  return texture;
}

export function cachedTextureCount() {
  return CACHE.size;
}

export function disposeMarkTextures() {
  for (const texture of CACHE.values()) texture.dispose();
  CACHE.clear();
}
