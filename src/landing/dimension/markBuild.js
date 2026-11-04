import * as THREE from "three";
import { RoundedBoxGeometry } from "three/examples/jsm/geometries/RoundedBoxGeometry.js";
import {
  MARK_SIZE,
  PLATE_CORNER,
  PLATE_DEPTH,
  RELIEF_LIFT,
  branchRuns,
  junctionPoint,
  plateOutline,
  ringNodes,
  stemInlay
} from "./markGeometry.js";

/* Geometry builders for the dimensional mark. Split from the component so the
   extrusion maths can be reasoned about on its own and so the scene keeps one
   place that decides how a logo coordinate becomes a solid. */

/** A rounded rectangle in the shape the extruder wants: drawn around the
   origin, corner radius taken from the shipped artwork. */
export function roundedRectShape(width, height, radius) {
  const shape = new THREE.Shape();
  const w = width / 2;
  const h = height / 2;
  const r = Math.min(radius, w, h);
  shape.moveTo(-w + r, -h);
  shape.lineTo(w - r, -h);
  shape.absarc(w - r, -h + r, r, -Math.PI / 2, 0, false);
  shape.lineTo(w, h - r);
  shape.absarc(w - r, h - r, r, 0, Math.PI / 2, false);
  shape.lineTo(-w + r, h);
  shape.absarc(-w + r, h - r, r, Math.PI / 2, Math.PI, false);
  shape.lineTo(-w, -h + r);
  shape.absarc(-w + r, -h + r, r, Math.PI, Math.PI * 1.5, false);
  return shape;
}

/* ExtrudeGeometry adds the chamfer outside the shape plane, so the plate's real
   front face sits further forward than PLATE_DEPTH / 2. */
const PLATE_BEVEL = 0.012;

/** The z of the plate's visible face. Anything that has to clear it — the
   faded stem, a measurement — is taken from here, not from the nominal depth. */
export function plateFrontZ(scale = 1) {
  return (PLATE_DEPTH * 0.5 + PLATE_BEVEL) * scale;
}

/** The brand plate: the logo's own rounded square, extruded with a chamfer so
   the key light gets a break-up edge to catch. */
export function plateGeometry(scale = 1) {
  const plate = plateOutline();
  const geometry = new THREE.ExtrudeGeometry(
    roundedRectShape(plate.width * scale, plate.height * scale, plate.radius * scale),
    {
      depth: plate.depth * scale,
      bevelEnabled: true,
      bevelThickness: PLATE_BEVEL * scale,
      bevelSize: 0.014 * scale,
      bevelSegments: 2,
      curveSegments: 24
    }
  );
  // Centred on z so the relief can be measured from the front face.
  geometry.translate(0, 0, -plate.depth * scale * 0.5);
  return geometry;
}

/** The slab the plate is mounted into — wider, deeper, matte charcoal. */
export function plinthGeometry(scale = 1) {
  const size = MARK_SIZE * 1.34 * scale;
  return new RoundedBoxGeometry(size, size, 0.42 * scale, 3, 0.24 * scale);
}

/** One raised branch: a rounded bar running between two logo coordinates. */
export function branchGeometry(run, scale = 1) {
  const dx = run.to.x - run.from.x;
  const dy = run.to.y - run.from.y;
  const length = Math.hypot(dx, dy) * scale;
  const width = run.width * scale;
  const depth = (RELIEF_LIFT + 0.03) * scale;
  const geometry = new RoundedBoxGeometry(length + width * 0.6, width, depth, 2, width * 0.3);
  return {
    geometry,
    position: [
      (run.from.x + run.to.x) / 2 * scale,
      (run.from.y + run.to.y) / 2 * scale,
      PLATE_DEPTH * 0.5 * scale + depth * 0.34
    ],
    rotation: [0, 0, Math.atan2(dy, dx)]
  };
}

/** Every branch as a solid. Each run is a different length, so each needs its
   own geometry; the caller owns disposal. */
export function branchSolids(scale = 1) {
  return branchRuns().map(run => ({ id: run.id, ...branchGeometry(run, scale) }));
}

/** The three input rings and the one output ring, as real tori. */
export function ringTransforms(scale = 1) {
  return ringNodes().map(node => ({
    id: node.id,
    role: node.role,
    radius: node.radius * scale,
    tube: node.tube * scale,
    position: [node.centre.x * scale, node.centre.y * scale, PLATE_DEPTH * 0.5 * scale + node.tube * scale * 0.7]
  }));
}

/** The translucent centre stem of the flat mark becomes a shallow inlay.
   In the artwork it is charcoal ink painted over the orange face, so the solid
   has to sit on that face; sunk to the nominal depth it disappears inside the
   plate and the logo loses its middle stem. */
export function inlayTransform(scale = 1) {
  const inlay = stemInlay();
  const depth = inlay.depth * scale;
  return {
    width: inlay.width * scale,
    height: inlay.height * scale,
    depth,
    position: [
      inlay.x * scale,
      inlay.centreY * scale,
      plateFrontZ(scale) + 0.0022 * scale - depth / 2
    ],
    opacity: inlay.opacity
  };
}

/** A thin lit band where plate meets plinth: the mark's only glow. */
export function seamGeometry(scale = 1) {
  const size = MARK_SIZE * scale * 0.995;
  return new RoundedBoxGeometry(size, size, 0.022 * scale, 2, PLATE_CORNER / 1024 * MARK_SIZE * scale * 0.98);
}

/** The routing point of the mark in world space, so a cable can leave from the
   place the logo actually converges rather than from the object's centre. */
export function junctionWorld(scale = 1) {
  const junction = junctionPoint();
  return new THREE.Vector3(junction.x * scale, junction.y * scale, PLATE_DEPTH * 0.5 * scale);
}
