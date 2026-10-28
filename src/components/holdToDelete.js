export const HOLD_TO_DELETE_MS = 1600;

export function holdProgress(startedAt, now, duration = HOLD_TO_DELETE_MS) {
  if (!Number.isFinite(startedAt) || !Number.isFinite(now) || !Number.isFinite(duration) || duration <= 0) {
    return 0;
  }
  return Math.min(1, Math.max(0, (now - startedAt) / duration));
}

export function holdReached(startedAt, now, duration = HOLD_TO_DELETE_MS) {
  return holdProgress(startedAt, now, duration) >= 1;
}

export function formatHoldSeconds(duration = HOLD_TO_DELETE_MS) {
  const seconds = Math.max(0, Number(duration) || 0) / 1000;
  return seconds.toFixed(1).replace(/\.0$/, "");
}

export const HOLD_PROGRESS_STEPS = 4;

// `prefers-reduced-motion` removes the CSS transition, but the fill is still driven
// frame by frame, so quantise it into a few discrete jumps instead of a sweep.
export function stepHoldProgress(progress, steps = HOLD_PROGRESS_STEPS) {
  if (!Number.isFinite(progress)) return 0;
  const clamped = Math.min(1, Math.max(0, progress));
  if (clamped >= 1) return 1;
  return Math.ceil(clamped * steps) / steps;
}
