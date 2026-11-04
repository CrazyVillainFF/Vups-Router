/* Where the camera stands and what the object is doing, as a function of scroll.

   The stage is one Canvas that survives from the hero to the routing section, so
   its "scenes" are poses rather than remounts. This module decides those poses
   and interpolates between them; it imports neither React nor three.js, so the
   choreography can be asserted in a plain Node test and reused by the DOM poster
   if the canvas never gets a GL context.

   Nothing here reads the scroll bar. The scroll hook writes `progress` into a
   mutable ref and the render loop asks this module what that means. */

/** A pose is a complete description of one moment of the stage.
 *
 *   The act is three panels of copy scrolling over one sticky canvas, and a
 *   scroll of `n` viewports moves the progress by `n / 2` (the act is three
 *   viewports tall and the viewport is one), so the three panels reach the
 *   centre of the screen at 0, 0.5 and 1. Those are the `at` values below — the
 *   camera turns exactly where a reader is looking, which is the only reason
 *   this file is allowed to know about scroll at all.
 */
export const POSE_PHASES = [
  {
    id: "hero",
    /* `at` is normalised scroll progress across the whole dimensional act, so
       the beats are proportions of a known distance rather than pixel values
       that move when a breakpoint changes. */
    at: 0,
    camera: { x: 0, y: 0.3, z: 6.15 },
    target: { x: 0, y: 0, z: 0 },
    /* The mark sits right of centre because the copy column owns the left half
       of the frame; the camera does not chase it, which keeps the object from
       swimming while a reader is trying to read. At 0.72 the plate clears the
       facts ledger, which is text a reader has to be able to finish. */
    mark: { x: 1.3, y: 0.04, z: 0, scale: 0.72, spin: 0 },
    /* The constellation stays parked until the network beat earns its place. */
    reveal: 0,
    nodes: 0,
    floor: 0
  },
  {
    id: "product",
    at: 0.5,
    /* The object slides further right and the camera pushes left: the swing is
       what makes the second panel read as a move rather than as a new scene. */
    camera: { x: -0.85, y: 0.5, z: 5.7 },
    target: { x: 0.5, y: 0.04, z: 0 },
    mark: { x: 1.2, y: 0.12, z: -0.35, scale: 0.86, spin: -0.3 },
    reveal: 0.08,
    nodes: 0.25,
    floor: 0.4
  },
  {
    id: "network",
    at: 1,
    /* Wide and high enough that every housing and every drawn cable is in one
       frame; this is the pose the scroll has been building toward. The object
       moves to the right of the copy column rather than sitting behind it — text
       a reader has to be able to finish, and a mark cut in half by it reads as a
       bug. */
    camera: { x: 0.2, y: 0.72, z: 10.5 },
    target: { x: 0.35, y: -0.04, z: 0 },
    mark: { x: 1.62, y: -0.12, z: 0, scale: 0.62, spin: 0.14 },
    reveal: 1,
    nodes: 1,
    floor: 0.8
  }
];

const lerp = (a, b, t) => a + (b - a) * t;

/** Smoothstep between two bounds, clamped — the stage never snaps between beats. */
export function smoothstep(edge, edgeNext, value) {
  if (edgeNext <= edge) return value >= edgeNext ? 1 : 0;
  const t = Math.min(1, Math.max(0, (value - edge) / (edgeNext - edge)));
  return t * t * (3 - 2 * t);
}

/** The pose for a scroll position. Returns fresh plain objects; callers copy
    them into the three.js vectors they own. */
export function poseAt(progress) {
  const value = Math.min(1, Math.max(0, Number.isFinite(progress) ? progress : 0));
  let lower = POSE_PHASES[0];
  let upper = POSE_PHASES[POSE_PHASES.length - 1];
  for (let index = 0; index < POSE_PHASES.length - 1; index += 1) {
    const a = POSE_PHASES[index];
    const b = POSE_PHASES[index + 1];
    if (value >= a.at && value <= b.at) {
      lower = a;
      upper = b;
      break;
    }
  }
  const t = smoothstep(lower.at, upper.at, value);

  const mixGroup = name => {
    const from = lower[name];
    const to = upper[name];
    const out = {};
    for (const key of Object.keys(from)) out[key] = lerp(from[key], to[key], t);
    return out;
  };

  return {
    from: lower.id,
    to: upper.id,
    t,
    camera: mixGroup("camera"),
    target: mixGroup("target"),
    mark: mixGroup("mark"),
    reveal: lerp(lower.reveal, upper.reveal, t),
    nodes: lerp(lower.nodes, upper.nodes, t),
    floor: lerp(lower.floor, upper.floor, t)
  };
}

/** How far a single cable is drawn, given its place in the reveal order. Cables
    arrive in sequence instead of all at once, which is what makes the network
    read as something being built rather than a picture fading in. */
export function cableDraw(reveal, index, count) {
  const total = Math.max(1, count);
  const step = 1 / total;
  const start = index * step * 0.72;
  return smoothstep(start, start + step * 1.6 + 0.12, reveal);
}

/** The id of the phase the stage is closest to, so the DOM can say what the
    canvas is showing without describing a render it cannot inspect. */
export function phaseId(progress) {
  const value = Math.min(1, Math.max(0, Number.isFinite(progress) ? progress : 0));
  let best = POSE_PHASES[0];
  for (const phase of POSE_PHASES) {
    if (Math.abs(phase.at - value) < Math.abs(best.at - value)) best = phase;
  }
  return best.id;
}
