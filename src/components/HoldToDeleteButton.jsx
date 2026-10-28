import React, { useCallback, useEffect, useId, useRef, useState } from "react";
import { HOLD_TO_DELETE_MS, holdProgress, stepHoldProgress } from "./holdToDelete.js";

function usePrefersReducedMotion() {
  const [reduced, setReduced] = useState(
    () => typeof window !== "undefined" && typeof window.matchMedia === "function"
      ? window.matchMedia("(prefers-reduced-motion: reduce)").matches
      : false
  );

  useEffect(() => {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") return undefined;
    const query = window.matchMedia("(prefers-reduced-motion: reduce)");
    const onChange = event => setReduced(event.matches);
    setReduced(query.matches);
    if (typeof query.addEventListener !== "function") {
      query.addListener(onChange);
      return () => query.removeListener(onChange);
    }
    query.addEventListener("change", onChange);
    return () => query.removeEventListener("change", onChange);
  }, []);

  return reduced;
}

export default function HoldToDeleteButton({
  onHold,
  disabled = false,
  holdTime = HOLD_TO_DELETE_MS,
  resetKey = 0,
  label = "Hold to Delete",
  describedBy
}) {
  const [phase, setPhase] = useState("idle");
  const [progress, setProgress] = useState(0);
  const reducedMotion = usePrefersReducedMotion();
  const reducedMotionRef = useRef(reducedMotion);
  reducedMotionRef.current = reducedMotion;
  const startRef = useRef(null);
  const frameRef = useRef(0);
  const pointerRef = useRef(null);
  const completedRef = useRef(false);
  const statusId = useId();

  const stopFrame = useCallback(() => {
    if (frameRef.current) {
      cancelAnimationFrame(frameRef.current);
      frameRef.current = 0;
    }
  }, []);

  const reset = useCallback(() => {
    stopFrame();
    startRef.current = null;
    pointerRef.current = null;
    completedRef.current = false;
    setPhase("idle");
    setProgress(0);
  }, [stopFrame]);

  useEffect(() => {
    reset();
  }, [reset, resetKey]);

  const complete = useCallback(() => {
    if (completedRef.current) return;
    completedRef.current = true;
    stopFrame();
    startRef.current = null;
    pointerRef.current = null;
    setProgress(1);
    setPhase("done");
    onHold?.();
  }, [onHold, stopFrame]);

  const tick = useCallback(
    now => {
      if (startRef.current === null) return;
      const next = holdProgress(startRef.current, now, holdTime);
      setProgress(reducedMotionRef.current ? stepHoldProgress(next) : next);
      if (next >= 1) {
        complete();
        return;
      }
      frameRef.current = requestAnimationFrame(tick);
    },
    [complete, holdTime]
  );

  const begin = useCallback(() => {
    if (disabled || completedRef.current || startRef.current !== null) return;
    startRef.current = performance.now();
    setPhase("holding");
    setProgress(0);
    frameRef.current = requestAnimationFrame(tick);
  }, [disabled, tick]);

  const cancel = useCallback(() => {
    if (startRef.current === null) return;
    stopFrame();
    startRef.current = null;
    pointerRef.current = null;
    setPhase("idle");
    setProgress(0);
  }, [stopFrame]);

  useEffect(() => {
    if (phase !== "holding") return undefined;
    const onWindowBlur = () => cancel();
    const onVisibilityChange = () => {
      if (document.visibilityState !== "visible") cancel();
    };
    window.addEventListener("blur", onWindowBlur);
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => {
      window.removeEventListener("blur", onWindowBlur);
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, [cancel, phase]);

  useEffect(() => () => stopFrame(), [stopFrame]);

  const onPointerDown = event => {
    if (event.pointerType === "mouse" && event.button !== 0) return;
    pointerRef.current = event.pointerId;
    try {
      event.currentTarget.setPointerCapture(event.pointerId);
    } catch {}
    begin();
  };

  const onPointerMove = event => {
    if (startRef.current === null || event.pointerType !== "mouse") return;
    const rect = event.currentTarget.getBoundingClientRect();
    if (
      event.clientX < rect.left ||
      event.clientX > rect.right ||
      event.clientY < rect.top ||
      event.clientY > rect.bottom
    ) {
      cancel();
    }
  };

  const onPointerEnd = event => {
    if (pointerRef.current !== event.pointerId) return;
    cancel();
  };

  const onKeyDown = event => {
    if (event.key !== " " && event.key !== "Enter") return;
    event.preventDefault();
    if (event.repeat) return;
    begin();
  };

  const onKeyUp = event => {
    if (event.key !== " " && event.key !== "Enter") return;
    event.preventDefault();
    cancel();
  };

  const status =
    phase === "holding"
      ? "Keep holding to delete."
      : phase === "done"
        ? "Hold complete. Deleting."
        : "";

  return (
    <button
      type="button"
      className="vr-hold-delete-button"
      data-phase={phase}
      data-reduced-motion={reducedMotion ? "" : undefined}
      style={{ "--hold-progress": String(progress) }}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerEnd}
      onPointerCancel={onPointerEnd}
      onLostPointerCapture={onPointerEnd}
      onPointerLeave={cancel}
      onKeyDown={onKeyDown}
      onKeyUp={onKeyUp}
      onBlur={cancel}
      onContextMenu={event => event.preventDefault()}
      onDragStart={event => event.preventDefault()}
      disabled={disabled}
      aria-label={`${label}. Press and hold for ${(holdTime / 1000).toFixed(1)} seconds.`}
      aria-describedby={[describedBy, statusId].filter(Boolean).join(" ") || undefined}
    >
      <span className="vr-hold-delete-button__fill" aria-hidden="true" />
      <span className="vr-hold-delete-button__label">
        {phase === "holding" ? "Keep holding..." : phase === "done" ? "Confirming deletion..." : label}
      </span>
      <span id={statusId} className="vr-hold-delete__sr" role="status" aria-live="polite">
        {status}
      </span>
    </button>
  );
}
