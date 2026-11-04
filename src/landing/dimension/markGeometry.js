/* The Vups mark, measured from public/vups-logo.svg.

   That file is the brand's only vector source: a rounded plate with a branch
   network and four rings, drawn in a 1024 unit viewBox. Nothing here invents a
   shape — every number below is read off the shipped artwork, converted once
   into world units, and the 3D components build geometry from it. If the logo
   changes, this module is the only place that has to change with it.

   Kept free of three.js and of React so the mapping can be asserted in a plain
   Node test, and so the DOM poster and the WebGL scene share one source of
   truth instead of measuring the same mark twice. */

export const MARK_VIEWBOX = 1024;

/* The drawing is centred on the viewBox and 2 world units wide, so a 1024-unit
   plate becomes 2.0 across. Every conversion below multiplies by this. */
export const MARK_SIZE = 2;
export const MARK_UNIT = MARK_SIZE / MARK_VIEWBOX;

export const PLATE_CORNER = 270;
export const PLATE_DEPTH = 0.19;
export const BRANCH_STROKE = 50;
export const RING_STROKE = 38;
export const STEM_WIDTH = 50;
export const STEM_TOP = 320;
export const STEM_BOTTOM = 560;

/* The raised branch network sits in front of the plate face instead of inside
   it, which is what gives the mark its machined relief under a key light. */
export const RELIEF_LIFT = 0.055;

const toUnit = value => value * MARK_UNIT;

/* SVG y grows downward, world y grows upward. */
const point = (x, y) => ({
  x: toUnit(x - MARK_VIEWBOX / 2),
  y: toUnit(MARK_VIEWBOX / 2 - y)
});

/** The rounded square the whole identity is cut into. */
export function plateOutline() {
  const half = MARK_SIZE / 2;
  return {
    width: MARK_SIZE,
    height: MARK_SIZE,
    radius: toUnit(PLATE_CORNER),
    depth: PLATE_DEPTH,
    corners: [
      point(270, 270),
      point(754, 270),
      point(754, 754),
      point(270, 754)
    ],
    bounds: { min: -half, max: half }
  };
}

/** The three visible branches: two diagonals into the junction, one stem down.
   Coordinates and the 50-unit stroke come from the `<g stroke-linecap="butt">`
   group in the shipped SVG. */
export function branchRuns() {
  return [
    { id: "left", from: point(330, 322), to: point(512, 610), width: toUnit(BRANCH_STROKE) },
    { id: "right", from: point(694, 322), to: point(512, 610), width: toUnit(BRANCH_STROKE) },
    { id: "stem", from: point(512, 580), to: point(512, 715), width: toUnit(BRANCH_STROKE) }
  ];
}

/** The faint centre stem in the artwork is a translucent inlay, not a raised
   branch, so the scene sinks it into the plate rather than lifting it. */
export function stemInlay() {
  const top = point(512, STEM_TOP);
  const bottom = point(512, STEM_BOTTOM);
  return {
    x: top.x,
    width: toUnit(STEM_WIDTH),
    height: Math.abs(top.y - bottom.y),
    centreY: (top.y + bottom.y) / 2,
    opacity: 0.35,
    depth: PLATE_DEPTH * 0.34
  };
}

/** Three input nodes along the top edge and one output node below the junction,
   exactly as the four `<circle>` rings are placed. */
export function ringNodes() {
  return [
    { id: "in-left", centre: point(312, 292), radius: toUnit(41), tube: toUnit(RING_STROKE / 2), role: "input" },
    { id: "in-centre", centre: point(512, 292), radius: toUnit(41), tube: toUnit(RING_STROKE / 2), role: "input" },
    { id: "in-right", centre: point(712, 292), radius: toUnit(41), tube: toUnit(RING_STROKE / 2), role: "input" },
    { id: "out", centre: point(512, 745), radius: toUnit(38), tube: toUnit(RING_STROKE / 2 - 1), role: "output" }
  ];
}

/** Where the two diagonals meet — the routing point of the mark, and the place
   the network scene later hangs its providers from. */
export function junctionPoint() {
  return point(512, 610);
}

/** A flat, readable description of the mark for the DOM poster and for tests.
   The canvas never becomes the only place the identity is described. */
export function markFacts() {
  return {
    plate: "rounded square",
    branches: branchRuns().map(run => run.id),
    nodes: ringNodes().map(node => node.id),
    source: "/vups-logo.svg"
  };
}

/** Ring placement for the constellation: providers are distributed on an arc
   whose radius is expressed in mark widths, so the composition scales with the
   object rather than with the viewport. */
export function orbitSlots(count, { radius = MARK_SIZE * 1.65, startDeg = -38, endDeg = 218, y = 0 } = {}) {
  const total = Math.max(1, Math.floor(Number(count) || 0));
  const spread = ((endDeg - startDeg) * Math.PI) / 180;
  const from = (startDeg * Math.PI) / 180;
  return Array.from({ length: total }, (_, index) => {
    const t = total === 1 ? 0.5 : index / (total - 1);
    const angle = from + spread * t;
    return {
      index,
      x: Math.cos(angle) * radius,
      y: y + Math.sin(angle) * radius * 0.42,
      z: Math.sin(angle) * radius * 0.34,
      angle
    };
  });
}
