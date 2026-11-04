export const CAMERA_FOV = 30;
export const WORLD_WIDTH = 3.6;
export const FLOOR_Y = -0.98;
export const DEPTH_SPAN = 1.45;

const HALF_TAN = Math.tan((CAMERA_FOV * Math.PI) / 360);

export function cameraDistance(aspect) {
  const safeAspect = Math.max(0.35, Math.min(3.2, aspect || 1.6));
  return Math.max(4.4, Math.min(11, WORLD_WIDTH / (2 * HALF_TAN * safeAspect)));
}

// Slot anchors are fractions of the layer box. World placement keeps every block
// standing on the floor plane, so height comes from the block's own edge length
// and the anchor's vertical fraction only chooses its depth on the shelf.
export function blockSide(slot, sizeScale) {
  return 0.74 * (slot?.scale ?? 1) * sizeScale;
}

export function blockPosition(slot, { side }) {
  return [
    ((slot.x ?? 0.5) - 0.5) * WORLD_WIDTH,
    FLOOR_Y + side / 2,
    -((slot.y ?? 0.5) - 0.5) * DEPTH_SPAN
  ];
}

export function pointerParallax(pointer, { motion = true } = {}) {
  if (!motion) return { x: 0, y: 0 };
  const x = Number(pointer?.x) || 0;
  const y = Number(pointer?.y) || 0;
  return { x: x * 0.34, y: -y * 0.2 };
}

// A block lift stated in pixels only means something once it is converted at the
// block's own depth, so the 8px rise reads identically on a phone and a desktop.
export function pixelsToWorld(px, distance, heightPx) {
  const safeHeight = Math.max(1, Number(heightPx) || 1);
  const safeDistance = Math.max(1, Number(distance) || 1);
  return (Math.max(0, Number(px) || 0) * 2 * safeDistance * HALF_TAN) / safeHeight;
}

export function qualityTier({ width = 1440, reducedMotion = false, coarse = false } = {}) {
  if (reducedMotion) return { dpr: 1, sizeScale: coarse ? 0.86 : 1, motion: false, shadows: false };
  if (coarse || width < 760) {
    return { dpr: 1.25, sizeScale: 0.86, motion: false, shadows: true };
  }
  if (width < 1200) return { dpr: 1.5, sizeScale: 0.94, motion: true, shadows: true };
  return { dpr: 1.5, sizeScale: 1, motion: true, shadows: true };
}
