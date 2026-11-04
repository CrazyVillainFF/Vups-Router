export const CAMERA_FOV = 30;
export const CAMERA_Z = 7.4;
export const CAMERA_Y = 0.55;
export const LOOK_Y = -0.2;
export const FLOOR_Y = -1.02;
export const BLOCK_SIDE = 0.62;
export const BLOCK_BEVEL = 0.12;
export const MAX_DPR = 1.5;
export const PARALLAX_MAX_DEGREES = 4;

const HALF_TAN = Math.tan((CAMERA_FOV * Math.PI) / 360);

export function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

export function lerp(a, b, t) {
  return a + (b - a) * t;
}

export function frustumHalfWidth(aspect, distance = CAMERA_Z) {
  const safe = clamp(Number(aspect) || 1.6, 0.5, 2.2);
  return distance * HALF_TAN * safe;
}

// The cluster is anchored to the right of the visible frustum instead of to a
// fixed world coordinate, so it stays clear of the headline column at every
// aspect ratio rather than sliding across the text on a narrow window.
export function heroLayout(aspect) {
  const half = frustumHalfWidth(aspect);
  const scale = clamp(half / 2.85, 0.52, 1.1);
  const edge = half * 0.52;
  const reach = half * 0.42;
  const side = BLOCK_SIDE * scale;
  const rows = [
    { y: FLOOR_Y + side / 2, xs: [-1, 0, 1], z: [0.14, -0.2, 0.06] },
    { y: FLOOR_Y + side * 1.5, xs: [-0.5, 0.5], z: [-0.06, 0.2] },
    { y: FLOOR_Y + side * 2.5, xs: [0], z: [0.02] }
  ];
  const placed = [];
  for (const row of rows) {
    for (let i = 0; i < row.xs.length; i += 1) {
      placed.push({
        x: edge + row.xs[i] * reach,
        y: row.y,
        z: row.z[i],
        rotY: row.xs[i] * 0.13,
        rotZ: (i % 2 ? 1 : -1) * 0.025,
        scale
      });
    }
  }
  return placed;
}

// Degrees, not fractions: the brief caps cursor parallax at 4 degrees, and a
// camera that swings on a sphere cannot drift in front of the floor seam.
export function parallaxPose(pointer, { motion = true } = {}) {
  if (!motion) return { x: 0, y: 0 };
  const px = clamp(Number(pointer?.x) || 0, -1, 1);
  const py = clamp(Number(pointer?.y) || 0, -1, 1);
  const radians = (PARALLAX_MAX_DEGREES * Math.PI) / 180;
  return {
    x: Math.sin(px * radians) * CAMERA_Z,
    y: CAMERA_Y - Math.sin(py * radians) * CAMERA_Z * 0.6
  };
}

// Below 768px, on a coarse pointer, with reduced motion or without a WebGL
// context the page shows the poster instead of a canvas.
export function stageTier({ width = 1440, reducedMotion = false, coarse = false, webgl = true } = {}) {
  if (!webgl || reducedMotion || coarse || width < 768) {
    return { webgl: false, dpr: 1, motion: false, shadows: false };
  }
  if (width < 1100) return { webgl: true, dpr: 1.25, motion: true, shadows: true };
  return { webgl: true, dpr: MAX_DPR, motion: true, shadows: true };
}
