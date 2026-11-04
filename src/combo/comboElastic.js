import { wireControl, wirePathWithControl } from "./comboCoreLayout.js";

// Damped harmonic oscillators: k pulls toward the target, c removes energy.
// damping = 2*sqrt(k) is critical; the values below sit just under it so a
// released node glides to rest without ringing.
export const NODE_SPRING = { stiffness: 330, damping: 34 };
export const DRAG_SPRING = { stiffness: 900, damping: 60 };
export const WIRE_SPRING = { stiffness: 115, damping: 21 };

export const SETTLE_DISTANCE = 0.08;
export const SETTLE_VELOCITY = 0.5;
export const KEYBOARD_STEP = 12;
export const KEYBOARD_STEP_MAJOR = 40;

const MAX_FRAME_MS = 64;
const SUB_STEP_MS = 8;
const TAUT_SPEED = 420;
const MIN_TENSION = 0.18;

export function createSpring(x, y) {
  return { x, y, vx: 0, vy: 0, targetX: x, targetY: y };
}

export function setSpringTarget(spring, targetX, targetY) {
  spring.targetX = targetX;
  spring.targetY = targetY;
}

export function snapSpring(spring) {
  spring.x = spring.targetX;
  spring.y = spring.targetY;
  spring.vx = 0;
  spring.vy = 0;
}

export function springAtRest(spring) {
  return (
    Math.abs(spring.x - spring.targetX) < SETTLE_DISTANCE &&
    Math.abs(spring.y - spring.targetY) < SETTLE_DISTANCE &&
    Math.abs(spring.vx) < SETTLE_VELOCITY &&
    Math.abs(spring.vy) < SETTLE_VELOCITY
  );
}

export function springSpeed(spring) {
  return Math.hypot(spring.vx, spring.vy);
}

export function clampToBounds(x, y, bounds) {
  if (!bounds) return { x, y };
  return {
    x: Math.min(bounds.maxX, Math.max(bounds.minX, x)),
    y: Math.min(bounds.maxY, Math.max(bounds.minY, y))
  };
}

// Semi-implicit Euler with fixed 8ms sub-steps: frame-rate independent, and
// stable for the stiffness values above even on a throttled tab.
export function stepSpring(spring, params = NODE_SPRING, dtMs = 16) {
  if (!Number.isFinite(spring.x) || !Number.isFinite(spring.y)) {
    snapSpring(spring);
    return true;
  }
  const elapsed = Math.min(MAX_FRAME_MS, Math.max(0, Number(dtMs) || 0));
  if (elapsed === 0) return springAtRest(spring);
  const steps = Math.ceil(elapsed / SUB_STEP_MS);
  const h = elapsed / 1000 / steps;
  const stiffness = Number(params.stiffness) || NODE_SPRING.stiffness;
  const damping = Number(params.damping) || NODE_SPRING.damping;
  for (let index = 0; index < steps; index += 1) {
    const ax = -stiffness * (spring.x - spring.targetX) - damping * spring.vx;
    const ay = -stiffness * (spring.y - spring.targetY) - damping * spring.vy;
    spring.vx += ax * h;
    spring.vy += ay * h;
    spring.x += spring.vx * h;
    spring.y += spring.vy * h;
  }
  if (springAtRest(spring)) snapSpring(spring);
  return springAtRest(spring);
}

function controlFor(geometry, x, y, bendSign, tension = 1) {
  return wireControl(geometry.center, geometry.centerRadius, geometry.nodeRadius, x, y, bendSign, tension);
}

export function createNodeEntry(node, geometry) {
  const bendSign = node.index % 2 === 0 ? 1 : -1;
  const control = controlFor(geometry, node.x, node.y, bendSign);
  return {
    key: node.key,
    index: node.index,
    bendSign,
    homeX: node.x,
    homeY: node.y,
    normX: null,
    normY: null,
    dragging: false,
    geometryWidth: geometry.width,
    geometryHeight: geometry.height,
    node: createSpring(node.x, node.y),
    wire: createSpring(control.x, control.y)
  };
}

// A dragged node keeps a normalized position so the arrangement survives a
// resize instead of snapping back onto the ring.
export function entryHome(entry, layout) {
  if (entry.normX === null || entry.normY === null) {
    return { x: entry.homeX, y: entry.homeY };
  }
  return clampToBounds(entry.normX * layout.width, entry.normY * layout.height, layout.bounds);
}

export function moveEntry(entry, x, y, layout, reduced = false) {
  const point = clampToBounds(x, y, layout.bounds);
  entry.normX = layout.width > 0 ? point.x / layout.width : 0;
  entry.normY = layout.height > 0 ? point.y / layout.height : 0;
  setSpringTarget(entry.node, point.x, point.y);
  if (reduced) {
    snapSpring(entry.node);
    const control = controlFor(layout, entry.node.x, entry.node.y, entry.bendSign);
    setSpringTarget(entry.wire, control.x, control.y);
    snapSpring(entry.wire);
  }
  return point;
}

export function resetEntry(entry, layout, reduced = false) {
  entry.normX = null;
  entry.normY = null;
  entry.dragging = false;
  setSpringTarget(entry.node, entry.homeX, entry.homeY);
  if (reduced) {
    snapSpring(entry.node);
    const control = controlFor(layout, entry.homeX, entry.homeY, entry.bendSign);
    setSpringTarget(entry.wire, control.x, control.y);
    snapSpring(entry.wire);
  }
}

// A wire under tension straightens: the faster the node travels, the flatter
// the curve, which is what reads as elastic stretch.
export function wireTension(speed) {
  return Math.max(MIN_TENSION, 1 / (1 + Math.max(0, speed) / TAUT_SPEED));
}

export function entryWireTarget(entry, layout) {
  return controlFor(layout, entry.node.x, entry.node.y, entry.bendSign, wireTension(springSpeed(entry.node)));
}

export function entryWirePath(entry, layout) {
  return wirePathWithControl(
    layout.center,
    layout.centerRadius,
    layout.nodeRadius,
    entry.node.x,
    entry.node.y,
    { x: entry.wire.x, y: entry.wire.y }
  );
}

// Advances one provider's node and wire springs. Returns true while both are
// at rest, so the caller can stop the animation loop once the network settles.
export function stepEntry(entry, layout, dtMs, reduced = false) {
  const home = entryHome(entry, layout);
  setSpringTarget(entry.node, home.x, home.y);
  if (reduced) {
    snapSpring(entry.node);
    const control = entryWireTarget(entry, layout);
    setSpringTarget(entry.wire, control.x, control.y);
    snapSpring(entry.wire);
    return true;
  }
  const nodeAtRest = stepSpring(entry.node, entry.dragging ? DRAG_SPRING : NODE_SPRING, dtMs);
  const control = entryWireTarget(entry, layout);
  setSpringTarget(entry.wire, control.x, control.y);
  const wireAtRest = stepSpring(entry.wire, WIRE_SPRING, dtMs);
  return nodeAtRest && wireAtRest;
}

export function syncEntries(entries, layout) {
  const previous = new Map(entries);
  entries.clear();
  for (const node of layout.nodes) {
    const existing = previous.get(node.key);
    if (existing) {
      const resized =
        existing.geometryWidth !== layout.width || existing.geometryHeight !== layout.height;
      existing.index = node.index;
      existing.homeX = node.x;
      existing.homeY = node.y;
      existing.geometryWidth = layout.width;
      existing.geometryHeight = layout.height;
      // A resize moves every home position at once, so an existing node must
      // jump to its new spot. Left to its spring it would fly across the canvas
      // from the old geometry and appear to explode on first measure.
      if (resized) {
        const home = entryHome(existing, layout);
        setSpringTarget(existing.node, home.x, home.y);
        snapSpring(existing.node);
        const control = entryWireTarget(existing, layout);
        setSpringTarget(existing.wire, control.x, control.y);
        snapSpring(existing.wire);
      }
      entries.set(node.key, existing);
      continue;
    }
    entries.set(node.key, createNodeEntry(node, layout));
  }
}

export function setNodeTransform(element, entry) {
  if (!element) return;
  const offsetX = entry.node.x - entry.homeX;
  const offsetY = entry.node.y - entry.homeY;
  element.style.transform = `translate(calc(-50% + ${offsetX.toFixed(2)}px), calc(-50% + ${offsetY.toFixed(2)}px))`;
}

export function setWirePath(pathElement, entry, layout) {
  if (!pathElement) return;
  pathElement.setAttribute("d", entryWirePath(entry, layout));
}
