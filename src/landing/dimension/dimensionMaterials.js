import { token } from "../../tokens.js";
import * as THREE from "three";

/* Materials for the dimensional mark and the routing constellation.

   WebGL cannot resolve a CSS custom property, so every colour here comes from
   the JS mirror of the token layer — the same pairing the no-hex guard checks.
   Nothing at a call site states a literal.

   The identity rule is deliberately conservative: the brand plate keeps the flat
   logo's orange face and charcoal relief, and only the *plinth it is mounted on*
   is new. Orange stays a signature material, never a wall.

   These materials are the mark's fallback body: when the ReactBits Metallic Paint
   surface carries the logo the stage does not mount the plate at all, so nothing
   here paints behind the chrome mark. */

export function plateMaterial(palette = undefined) {
  return new THREE.MeshStandardMaterial({
    color: token("accent", palette),
    roughness: 0.46,
    metalness: 0.18,
    envMapIntensity: 0.85,
    /* ACES flattens a saturated brand orange into a brick red, and this face is
       the logo rather than a material study. The label planes already opt out
       for the same reason. */
    toneMapped: false,
    /* The scene's lights leave the face at about 70% of the flat mark's own
       orange, which makes the 3D logo disagree with the one in the navigation.
       An emissive floor brings the face back to the shipped colour; the edge
       material below keeps the lighting so the plate still reads as a solid. */
    emissive: token("accent", palette),
    emissiveIntensity: 0.5
  });
}

/** The plate's side walls and chamfer. Deliberately *not* given the face's
    emissive floor: this is the only surface that shows the plate has a depth. */
export function plateEdgeMaterial(palette = undefined) {
  return new THREE.MeshStandardMaterial({
    color: token("accent", palette),
    roughness: 0.46,
    metalness: 0.18,
    envMapIntensity: 0.85,
    toneMapped: false
  });
}

/** The ink of the flat logo, stood up off the plate as machined relief. */
export function reliefMaterial(palette = undefined) {
  return new THREE.MeshStandardMaterial({
    color: token("bg", palette),
    roughness: 0.62,
    metalness: 0.06,
    envMapIntensity: 0.7
  });
}

/** The artwork's faded centre stem: the logo's ink at the logo's own opacity,
   laid over the orange face instead of raised out of it. It is the one detail
   that is a transparency rather than a solid, because in the shipped mark the
   stem is a translucent rectangle and copying its colour outright would make
   the 3D logo disagree with the flat one. */
export function inlayMaterial(palette = undefined, opacity = 1) {
  return new THREE.MeshStandardMaterial({
    color: token("bg", palette),
    roughness: 0.7,
    metalness: 0.04,
    transparent: true,
    opacity,
    depthWrite: false,
    toneMapped: false
  });
}

/** Matte charcoal body the plate is mounted into. */
export function plinthMaterial(palette = undefined) {
  return new THREE.MeshStandardMaterial({
    color: token("surface-2", palette),
    roughness: 0.88,
    metalness: 0.04,
    envMapIntensity: 0.55
  });
}

/** A recessed, half-lit seam: the mark's only self-illuminated detail. */
export function seamMaterial(palette = undefined) {
  return new THREE.MeshStandardMaterial({
    color: token("bg", palette),
    emissive: token("accent", palette),
    emissiveIntensity: 0.55,
    roughness: 0.4,
    metalness: 0
  });
}

/** Provider housings: the same charcoal family as the plinth, lifted a step. */
export function nodeMaterial(palette = undefined) {
  return new THREE.MeshStandardMaterial({
    color: token("surface", palette),
    roughness: 0.72,
    metalness: 0.1,
    envMapIntensity: 0.6
  });
}

/** The lit sliver on the face of a housing: a port, not a status light. It is
   the same colour for every provider because the scene has no availability data
   to encode, and inventing one would be a claim about the app. */
export function portMaterial(palette = undefined) {
  return new THREE.MeshStandardMaterial({
    color: token("accent", palette),
    emissive: token("accent", palette),
    emissiveIntensity: 0.42,
    roughness: 0.35,
    metalness: 0
  });
}

/** Unlit cable. Energy is carried by a separate travelling bead, so the cable
   itself never claims activity the app has not reported. */
export function cableMaterial(palette = undefined) {
  return new THREE.MeshStandardMaterial({
    color: token("border-strong", palette),
    roughness: 0.55,
    metalness: 0.25,
    envMapIntensity: 0.5
  });
}

/** The travelling bead. Emissive, not bloom-fed: no post-processing pass is
   required for it to read, and it therefore survives on the low tier. */
export function pulseMaterial(palette = undefined) {
  return new THREE.MeshStandardMaterial({
    color: token("accent", palette),
    emissive: token("accent", palette),
    emissiveIntensity: 1.35,
    roughness: 0.3,
    metalness: 0
  });
}

export function disposeMaterials(materials) {
  for (const material of materials) material?.dispose?.();
}
