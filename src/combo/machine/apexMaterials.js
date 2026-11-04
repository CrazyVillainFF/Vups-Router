import { token, mix } from "../../tokens.js";
import * as THREE from "three";

// Shared material and colour vocabulary for the WebGL layer. Keeping it in one
// place means the core, the provider housings and the cables are lit by the same
// simulated studio and can never drift into three different metal languages.
//
// Every colour is read through `token()` at the moment a material is built, so a
// theme switch cannot be frozen into a module-level constant: the scene picks up
// whichever palette is live when it mounts, and an in-place switch re-sets the
// colours on the existing materials.

export function metal(color, roughness, metalness, extra) {
  return new THREE.MeshStandardMaterial({ color, roughness, metalness, ...extra });
}

export function additive(color, opacity) {
  return new THREE.MeshBasicMaterial({
    color,
    transparent: true,
    opacity,
    blending: THREE.AdditiveBlending,
    depthWrite: false
  });
}

// A metal with no diffuse term reflects whatever is around it, so a polished
// core with no environment map renders black. This gradient is that surround:
// a procedural equirect panorama, prefiltered once through PMREM at mount and
// disposed with the scene. Nothing is fetched over the network and no bitmap
// asset is invented.
const environmentStops = () => [
  { at: [0.2, 0.22], radius: 0.3, color: mix("accent", 0.82) },
  { at: [0.7, 0.34], radius: 0.34, color: mix("accent", 0.3) },
  { at: [0.46, 0.1], radius: 0.26, color: mix("accent", 0.32) },
  { at: [0.9, 0.74], radius: 0.28, color: mix("bg", 0.4) }
];

export function environmentCanvas() {
  const canvas = document.createElement("canvas");
  canvas.width = 256;
  canvas.height = 128;
  const ctx = canvas.getContext("2d");
  if (!ctx) return canvas;
  const sky = ctx.createLinearGradient(0, 0, 0, canvas.height);
  sky.addColorStop(0, token("bg"));
  sky.addColorStop(0.55, token("bg"));
  sky.addColorStop(1, token("bg"));
  ctx.fillStyle = sky;
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  for (const stop of environmentStops()) {
    const x = stop.at[0] * canvas.width;
    const y = stop.at[1] * canvas.height;
    const r = stop.radius * canvas.width;
    const glow = ctx.createRadialGradient(x, y, 0, x, y, r);
    glow.addColorStop(0, stop.color);
    glow.addColorStop(1, mix("slab", 0.02));
    ctx.fillStyle = glow;
    ctx.fillRect(0, 0, canvas.width, canvas.height);
  }
  return canvas;
}
