import { wireAnchors, wireControl } from "./comboCoreLayout.js";

// Pure world-space model for the 3D power core. Everything here is numbers so
// the scene can be unit-tested without a GPU; the renderer only turns these
// values into meshes and never decides anything on its own.

// One world unit is 100 css pixels at the node plane. Keeping the scale fixed
// means the same geometry reads identically on a phone and on a desktop
// window, and the camera distance below absorbs the viewport size.
export const PX_TO_WORLD = 0.01;
export const CAMERA_FOV = 32;

// Depth budget in css pixels, measured from the node plane so it scales with
// the layout. The housing body spans +/- housing/2, so everything that reads as
// a face or a lip has to sit above that or the body's own cap hides it.
export const DEPTH = {
  housing: 26,
  well: 14,
  groove: 15.4,
  rim: 16.6,
  energy: 17.6,
  logo: 19.4,
  node: 16,
  nodeFace: 9,
  nodeMark: 11,
  nodeRim: 12.6,
  cable: 4
};

const TAN_HALF_FOV = Math.tan((CAMERA_FOV / 2) * (Math.PI / 180));

// The renderer copies these numbers straight into three.js positions, so a
// signed zero from the y-flip is normalised out before it can reach a matrix.
function canonical(value) {
  return value === 0 ? 0 : value;
}

export function cameraDistance(heightPx, scale = PX_TO_WORLD, fov = CAMERA_FOV) {
  const halfFov = Math.tan((fov / 2) * (Math.PI / 180)) || TAN_HALF_FOV;
  return Math.max(1, (Math.max(1, Number(heightPx) || 0) * scale) / (2 * halfFov));
}

// The ring's optical center is not the middle of the box: the bottom pad is left
// empty for the captions and the status pill. A camera parked over the box center
// projects that center onto the middle of the canvas, which slides the whole 3D
// layer half a pad below the DOM nodes it is supposed to sit on. This is the
// shift that puts world origin back under layout.center.
export function cameraOffset(layout, size, scale = PX_TO_WORLD) {
  const width = Math.max(1, Number(size?.width) || Number(layout?.width) || 1);
  const height = Math.max(1, Number(size?.height) || Number(layout?.height) || 1);
  const centerX = Number.isFinite(Number(layout?.center?.x)) ? Number(layout.center.x) : width / 2;
  const centerY = Number.isFinite(Number(layout?.center?.y)) ? Number(layout.center.y) : height / 2;
  return {
    x: canonical((width / 2 - centerX) * scale),
    y: canonical((centerY - height / 2) * scale)
  };
}

// Pointer parallax is applied to the core housing only, and only as a *lean*.
// The camera never rotates, so a node on the z=0 plane keeps one exact
// world-to-screen rule, which is what lets the DOM hit targets sit under the
// rendered nodes at any window size - and what lets the cables, whose anchors
// come from layout.center, stay plugged into the painted housing. Translating
// the core group by the pointer would move that silhouette away from every
// cable end, so the pointer reaction tips the housing about its own axis
// instead: the perspective camera still parallax-shifts its depth, but the
// silhouette centre stays exactly where the layout put it.
export const PARALLAX_PX = { x: 26, y: 18 };

export function parallaxOffset(pointer, size) {
  const width = Math.max(1, size?.width || 1);
  const height = Math.max(1, size?.height || 1);
  const px = Number(pointer?.x);
  const py = Number(pointer?.y);
  if (!Number.isFinite(px) || !Number.isFinite(py)) return { x: 0, y: 0 };
  const nx = Math.min(1, Math.max(-1, (px / width) * 2 - 1));
  const ny = Math.min(1, Math.max(-1, (py / height) * 2 - 1));
  return { x: canonical(nx * PARALLAX_PX.x), y: canonical(ny * PARALLAX_PX.y) };
}

// Angular gain, in radians of lean per css pixel of pointer offset. Kept under
// the idle sway so the pointer tips the housing without dominating it.
export const PARALLAX_LAYERS = { core: 0.0022 };

export function parallaxLean(offsetPx, layer) {
  const amount = PARALLAX_LAYERS[layer] ?? 0;
  return {
    x: canonical((Number(offsetPx?.y) || 0) * amount),
    y: canonical((Number(offsetPx?.x) || 0) * amount)
  };
}

export function toWorld(px, py, layout, depthPx = 0, scale = PX_TO_WORLD) {
  return {
    x: canonical((px - layout.center.x) * scale),
    y: canonical(-(py - layout.center.y) * scale),
    z: canonical(depthPx * scale)
  };
}

export function toWorldSize(pxSize, scale = PX_TO_WORLD) {
  return Math.max(0, Number(pxSize) || 0) * scale;
}

export function wireAnchorsFor(entry, layout) {
  return wireAnchors(layout.center, layout.centerRadius, layout.nodeRadius, entry.node.x, entry.node.y);
}

// Samples the same quadratic curve the SVG fallback draws, so the cable in 3D
// and the wire in 2D describe one physical connection.
export function curvePoints(entry, layout, segments = 24) {
  const steps = Math.max(2, Math.floor(segments));
  const { start, end } = wireAnchorsFor(entry, layout);
  const control = { x: entry.wire.x, y: entry.wire.y };
  const points = new Array(steps + 1);
  for (let index = 0; index <= steps; index += 1) {
    const t = index / steps;
    const mt = 1 - t;
    points[index] = {
      x: mt * mt * start.x + 2 * mt * t * control.x + t * t * end.x,
      y: mt * mt * start.y + 2 * mt * t * control.y + t * t * end.y
    };
  }
  return points;
}

// Energy travels provider -> core, which is the receive direction.
export function curveAt(entry, layout, t) {
  const clamped = Math.min(1, Math.max(0, Number(t) || 0));
  const { start, end } = wireAnchorsFor(entry, layout);
  const control = { x: entry.wire.x, y: entry.wire.y };
  const mt = 1 - clamped;
  return {
    x: mt * mt * end.x + 2 * mt * clamped * control.x + clamped * clamped * start.x,
    y: mt * mt * end.y + 2 * mt * clamped * control.y + clamped * clamped * start.y
  };
}

export function relaxedControl(entry, layout) {
  return wireControl(layout.center, layout.centerRadius, layout.nodeRadius, entry.node.x, entry.node.y, entry.bendSign);
}

// How far the cable has been pulled from its relaxed curve. This is the visual
// "elastic" cue: a stretched connection bends, a released one settles.
export function wireStretch(entry, layout) {
  const rest = relaxedControl(entry, layout);
  const distance = Math.hypot(entry.wire.x - rest.x, entry.wire.y - rest.y);
  return Math.min(1, distance / 46);
}

// Cable thickness in world units. A cable is a conduit, not a surface: it stays
// a couple of css pixels wide so ten of them read as a harness instead of as
// eight blades. Pulling a node taut narrows it, which is how the tension shows.
// At the previous 2.4/100 a 50px housing produced a 1.2px line, which on a dark
// stage at 1x dpr fell below what users could see at all.
export const CABLE_PX = 4.6;

export function cableWidth(nodeRadiusPx, stretch = 0, scale = PX_TO_WORLD) {
  const radius = Math.max(0, Number(nodeRadiusPx) || 0);
  const pull = Math.min(1, Math.max(0, Number(stretch) || 0));
  return Math.max(0, radius * 2 * (CABLE_PX / 100) * (1 - pull * 0.28) * scale);
}

const RING_SPEED = { still: 0, idle: 0.06, connected: 0.16, active: 0.3 };

// Central core appearance. Every value is derived from state the orchestrator
// actually reported - nothing here ramps up on a timer.
export function coreModel(input) {
  const connected = input?.connected === true;
  const runActive = input?.runActive === true;
  const liveWorking = Math.max(0, Number(input?.liveWorking) || 0);
  const intensity = Math.min(1, Math.max(0, Number(input?.intensity) || 0));
  const engaged = connected || runActive;
  const energy = engaged ? Math.max(0.18, intensity) : 0;
  const speed = !engaged ? RING_SPEED.idle : runActive ? RING_SPEED.active : RING_SPEED.connected;
  return {
    // Idle must be visibly idle: no glow, no streams, no false activity.
    glow: engaged ? 0.35 + energy * 0.65 : 0,
    energy,
    ringSpeed: runActive ? speed * (1 + liveWorking * 0.04) : speed,
    ringSpread: engaged ? 1 + energy * 0.06 : 1,
    receive: runActive ? Math.min(1, 0.25 + liveWorking * 0.18) : 0,
    logoPulse: runActive ? 1 : connected ? 0.45 : 0,
    state: runActive ? "active" : connected ? "connected" : "idle"
  };
}

const NODE_EMISSIVE = { working: 0.55, live: 1, done: 0.3, failed: 0, queued: 0.18, idle: 0.08 };

export function nodeModel(input) {
  const status = input?.status || "unknown";
  const live = input?.live || null;
  const hovered = input?.hovered === true;
  const focused = input?.focused === true;
  const dragging = input?.dragging === true;
  let emissive = status === "working" ? NODE_EMISSIVE.working : NODE_EMISSIVE.idle;
  if (live === "working") emissive = NODE_EMISSIVE.live;
  else if (live === "done") emissive = NODE_EMISSIVE.done;
  else if (live === "failed") emissive = NODE_EMISSIVE.failed;
  else if (live === "queued") emissive = NODE_EMISSIVE.queued;
  return {
    // A failed provider must not keep pretending to work, but it stays legible.
    emissive,
    // A cable is allowed to look connected because a real check proved the
    // credential works; it is only allowed to look like it is transmitting
    // because a run said so. Those are separate flags on purpose.
    linked: status === "working",
    blocked: status === "not_working" || live === "failed",
    stream: live === "working",
    scale: dragging ? 1.12 : hovered || focused ? 1.07 : 1,
    rim: live === "failed" ? 0.1 : 0.35 + emissive * 0.65,
    halo: live === "working" ? 1 : live === "queued" ? 0.4 : 0,
    depth: status === "working" ? DEPTH.node : DEPTH.node * 0.7
  };
}

// Streams stay independent: each active provider gets its own phase offset so
// simultaneous answers do not merge into one strobe.
export function pulseSchedule(index, count, speed = 1) {
  const total = Math.max(1, count);
  return {
    delay: (index % total) / total,
    duration: Math.max(0.6, (2.1 - Math.min(0.7, (total - 1) * 0.06)) / (speed || 1)),
    offset: (index * 0.37) % 1
  };
}

const QUALITY = {
  full: { dpr: 2, segments: 26, pulses: 3 },
  balanced: { dpr: 1.5, segments: 18, pulses: 2 },
  light: { dpr: 1, segments: 12, pulses: 1 }
};

export function qualityTier(input = {}) {
  if (input.reduced) return QUALITY.light;
  const width = Number(input.width) || 0;
  const memory = Number(input.deviceMemory) || 0;
  const cores = Number(input.hardwareConcurrency) || 0;
  const small = width > 0 && width < 620;
  const strained = input.coarse === true || small || (memory && memory <= 4) || (cores && cores <= 4);
  if (!strained) return QUALITY.full;
  if (memory && memory <= 2) return QUALITY.light;
  return QUALITY.balanced;
}

export function entranceScale(progress) {
  const value = Math.min(1, Math.max(0, Number(progress) || 0));
  // back.out-ish overshoot without pulling in an easing dependency.
  const c1 = 1.70158;
  const c3 = c1 + 1;
  const t = value - 1;
  return 1 + c3 * t * t * t + c1 * t * t;
}

// The startup sequence is one monotonic driver (0 -> 1, written by the animation
// layer) plus this pure mapping, so the DOM shell and the WebGL machine reveal
// the same hardware in the same order and the phase boundaries can be asserted
// without a GPU. Every phase is a window into the driver; overlapping windows
// are what make the sequence read as one motion instead of six separate ones.
export const STARTUP_DURATION = 2.35;

export const STARTUP_PHASES = {
  environment: [0, 0.18],
  assembly: [0.12, 0.46],
  initialize: [0.4, 0.6],
  discovery: [0.5, 0.84],
  connection: [0.78, 0.96],
  activation: [0.9, 1]
};

export function startupPhase(driver, phase) {
  const window = STARTUP_PHASES[phase];
  if (!window) return 1;
  const value = Math.min(1, Math.max(0, Number(driver) || 0));
  const span = Math.max(0.0001, window[1] - window[0]);
  return Math.min(1, Math.max(0, (value - window[0]) / span));
}

// Discovery sweeps node by node. The step shrinks with the node count so the
// sweep always lands exactly on the end of the phase, whatever the layout -
// one provider gets the whole window, twenty still finish together.
export const NODE_SWEEP_STEP = 0.06;

export function nodeEntrance(progress, index, total) {
  const count = Math.max(1, Math.round(Number(total) || 1));
  const position = Math.min(count - 1, Math.max(0, Math.round(Number(index) || 0)));
  const step = count > 1 ? Math.min(NODE_SWEEP_STEP, 0.7 / (count - 1)) : NODE_SWEEP_STEP;
  const start = position * step;
  const span = Math.max(0.2, 1 - step * (count - 1));
  const value = Math.min(1, Math.max(0, Number(progress) || 0));
  return Math.min(1, Math.max(0, (value - start) / span));
}

// How much of a cable is milled during the connection phase. The ribbon grows
// out of the core toward the provider, so the machine reaches out rather than
// having wires appear already attached.
export function cableReveal(progress) {
  return 0.08 + 0.92 * Math.min(1, Math.max(0, Number(progress) || 0));
}
