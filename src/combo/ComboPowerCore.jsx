import React, { Suspense, useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { gsap } from "gsap";
import { HugeiconsIcon } from "@hugeicons/react";
import { RefreshIcon } from "@hugeicons/core-free-icons";
import VupsLogo from "../components/VupsLogo.jsx";
import { artworkStyle } from "./comboArtwork.js";
import { buildCoreLayout, coreIntensity, wireDots } from "./comboCoreLayout.js";
import { coreModel, qualityTier } from "./comboScene.js";
import useProviderActivity from "./hooks/useProviderActivity.js";
import {
  KEYBOARD_STEP,
  KEYBOARD_STEP_MAJOR,
  moveEntry,
  resetEntry,
  setNodeTransform,
  setWirePath,
  stepEntry,
  syncEntries
} from "./comboElastic.js";
import { buildProviderNetwork } from "./comboProviders.js";
import "./combo.css";

// three.js and the renderer stay out of the main bundle: the machine is only
// fetched once a WebGL context has actually been proven available.
const ComboMachine3D = React.lazy(() => import("./ComboMachine3D.jsx"));

// How long the machine keeps painting after the last thing that could have moved
// it. The elastic layer settles in well under a second, so this is the idle
// window after which an unchanged frame is simply not worth drawing again.
const IDLE_FRAME_WINDOW_MS = 1800;

let webglProbe = null;

function hasWebGL() {
  if (typeof window === "undefined" || typeof document === "undefined") return false;
  if (webglProbe === null) {
    try {
      const canvas = document.createElement("canvas");
      webglProbe = Boolean(canvas.getContext("webgl2") || canvas.getContext("webgl"));
    } catch {
      webglProbe = false;
    }
  }
  return webglProbe;
}

function useMachineMode(reduced) {
  const [enabled, setEnabled] = useState(() => !reduced && hasWebGL());
  useEffect(() => {
    if (reduced) setEnabled(false);
    else if (hasWebGL()) setEnabled(true);
  }, [reduced]);
  return [enabled, setEnabled];
}

// The frame loop has to stop for real when the tab goes away. Reading
// document.hidden during render never re-runs, so the machine would keep
// painting a scene nobody can see; this makes it a subscribed value.
function useDocumentVisible() {
  const [visible, setVisible] = useState(() => (
    typeof document === "undefined" ? true : !document.hidden
  ));
  useEffect(() => {
    if (typeof document === "undefined") return undefined;
    const onChange = () => setVisible(!document.hidden);
    document.addEventListener("visibilitychange", onChange);
    onChange();
    return () => document.removeEventListener("visibilitychange", onChange);
  }, []);
  return visible;
}

function useInView(ref) {
  const [visible, setVisible] = useState(true);
  useEffect(() => {
    const element = ref.current;
    if (!element || typeof IntersectionObserver === "undefined") return undefined;
    const observer = new IntersectionObserver(entries => {
      for (const entry of entries) setVisible(entry.isIntersecting);
    }, { rootMargin: "120px" });
    observer.observe(element);
    return () => observer.disconnect();
  }, [ref]);
  return visible;
}

function useReducedMotion() {
  const query = "(prefers-reduced-motion: reduce)";
  const [reduced, setReduced] = useState(() => (
    typeof window !== "undefined" && window.matchMedia ? window.matchMedia(query).matches : false
  ));
  useEffect(() => {
    if (typeof window === "undefined" || !window.matchMedia) return undefined;
    const media = window.matchMedia(query);
    const onChange = () => setReduced(media.matches);
    setReduced(media.matches);
    media.addEventListener?.("change", onChange);
    return () => media.removeEventListener?.("change", onChange);
  }, []);
  return reduced;
}

function useElementSize(ref) {
  const [size, setSize] = useState({ width: 0, height: 0 });
  useEffect(() => {
    const element = ref.current;
    if (!element) return undefined;
    const measure = () => {
      // Layout px, not painted px. The startup scales this box by 0.94 on entry,
      // and a transform leaves the layout box untouched, so a bounding-rect
      // measurement taken mid-entrance would never be corrected: the DOM
      // percentages and the 3D projection would then disagree by that 6% for
      // the whole session.
      const width = element.offsetWidth;
      const height = element.offsetHeight;
      setSize(current => (
        Math.abs(current.width - width) < 1 && Math.abs(current.height - height) < 1
          ? current
          : { width, height }
      ));
    };
    measure();
    if (typeof ResizeObserver === "undefined") {
      window.addEventListener("resize", measure);
      return () => window.removeEventListener("resize", measure);
    }
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [ref]);
  return size;
}

function ProviderMark({ art }) {
  return (
    <span
      className={`combo-provider-mark combo-provider-mark--${art.type}`}
      data-kind={art.type}
      /* Provider identity colour, and nothing else — see ModelArtwork.jsx. */
      data-brand="third-party identity"
      style={artworkStyle(art)}
      aria-hidden="true"
    >
      {art.type === "logo" ? <span className="combo-provider-mark__mask" /> : null}
      {art.type === "image" ? (
        <img
          className="combo-provider-mark__image"
          src={art.src}
          alt=""
          loading="lazy"
          decoding="async"
          draggable="false"
        />
      ) : null}
      {art.type === "wordmark" ? <span className="combo-provider-mark__word">{art.wordmark}</span> : null}
    </span>
  );
}

export default function ComboPowerCore({
  models = [],
  availability,
  activity,
  activeProviderId,
  startupRef,
  startupRunning = false,
  onProviderSelect
}) {
  const rootRef = useRef(null);
  const size = useElementSize(rootRef);
  const reduced = useReducedMotion();
  const uid = useId().replace(/[^a-zA-Z0-9_-]/g, "");
  const seenKeys = useRef(new Set());

  const providers = useMemo(() => buildProviderNetwork(models), [models]);
  const layout = useMemo(() => buildCoreLayout(providers, {
    width: size.width || undefined,
    height: size.height || undefined
  }), [providers, size.width, size.height]);

  const entriesRef = useRef(new Map());
  const elementsRef = useRef(new Map());
  const frameRef = useRef(0);
  const clockRef = useRef(0);
  const layoutRef = useRef(layout);
  const reducedRef = useRef(reduced);
  const dragRef = useRef(null);
  // A drag has to stay a drag: the click that the browser fires after pointerup
  // must never be read as a selection when the user was moving the node.
  const dragMovedRef = useRef(false);
  const [hasCustomPositions, setHasCustomPositions] = useState(false);
  const interactionRef = useRef({ hovered: null, focused: null });
  // null means "no pointer over the stage", which the scene reads as centred and
  // therefore as no lean at all. A real {x,y} starting at 0,0 would park the
  // housing at the clamped top-left extreme until the first pointermove.
  const pointerRef = useRef(null);
  const [machineEnabled, setMachineEnabled] = useMachineMode(reduced);
  const machineInView = useInView(rootRef);
  const documentVisible = useDocumentVisible();
  const settledStartupRef = useRef(1);
  const activeStartupRef = startupRef || settledStartupRef;
  // Demand rendering is a mode the canvas can only be switched into from the
  // outside, so the shell that owns every input event also owns the wake signal.
  const [awake, setAwake] = useState(true);
  const sleepTimerRef = useRef(0);
  const wake = useCallback(() => {
    setAwake(current => (current ? current : true));
    if (typeof window === "undefined") return;
    window.clearTimeout(sleepTimerRef.current);
    sleepTimerRef.current = window.setTimeout(() => setAwake(false), IDLE_FRAME_WINDOW_MS);
  }, []);
  const quality = useMemo(() => qualityTier({
    width: size.width,
    height: size.height,
    coarse: typeof window !== "undefined" && window.matchMedia
      ? window.matchMedia("(pointer: coarse)").matches
      : false,
    deviceMemory: typeof navigator !== "undefined" ? navigator.deviceMemory : 0,
    hardwareConcurrency: typeof navigator !== "undefined" ? navigator.hardwareConcurrency : 0,
    reduced
  }), [size.width, size.height, reduced]);

  // Availability and live run activity, joined per provider. Everything the
  // machine lights up is a value these two real sources produced.
  const {
    statusById,
    liveById,
    summary,
    counts,
    liveWorking,
    runActive
  } = useProviderActivity({ providers, availability, activity });

  const connected = summary.working > 0;
  const intensity = runActive
    ? coreIntensity(Math.max(1, liveWorking), providers.length)
    : coreIntensity(summary.working, providers.length);
  const energyKeys = useMemo(() => {
    if (!runActive) return new Set();
    const dots = wireDots(layout, key => (liveById.get(key) === "working" ? "working" : "idle"));
    return new Set(dots.map(node => node.key));
  }, [layout, liveById, runActive]);
  const providerSignature = providers.map(provider => provider.id).join("|");
  const liveSignature = providers.map(provider => `${provider.id}:${liveById.get(provider.id) || ""}`).join("|");
  const energySignature = [...energyKeys].join("|");
  const machineCore = useMemo(() => coreModel({ connected, runActive, liveWorking, intensity }),
    [connected, runActive, liveWorking, intensity]);

  useEffect(() => {
    const root = rootRef.current;
    if (!root) return undefined;
    const current = new Set(providerSignature ? providerSignature.split("|") : []);
    for (const key of [...seenKeys.current]) {
      if (!current.has(key)) seenKeys.current.delete(key);
    }
    const fresh = [...root.querySelectorAll(".combo-provider-node")]
      .filter(node => !seenKeys.current.has(node.dataset.provider));
    fresh.forEach(node => seenKeys.current.add(node.dataset.provider));
    if (reduced || fresh.length === 0) return undefined;
    // The wrapper transform belongs to the elastic layer, so the entrance
    // animation runs on the inner disc instead.
    const discs = fresh
      .map(node => node.querySelector(".combo-provider-node__disc"))
      .filter(Boolean);
    if (discs.length === 0) return undefined;
    const context = gsap.context(() => {
      gsap.fromTo(
        discs,
        { autoAlpha: 0, scale: 0.72 },
        {
          autoAlpha: 1,
          scale: 1,
          duration: 0.55,
          stagger: 0.06,
          ease: "back.out(1.6)",
          overwrite: true,
          clearProps: "transform,opacity,visibility"
        }
      );
    }, root);
    return () => context.revert();
  }, [providerSignature, reduced]);

  useEffect(() => {
    const root = rootRef.current;
    if (!root) return undefined;
    const context = gsap.context(() => {
      if (reduced) {
        gsap.set(".combo-core__glow", { scale: 1 });
        gsap.set(".combo-core__plate", { scale: 1 });
        return;
      }
      gsap.to(".combo-core__groove", {
        rotate: 360,
        duration: connected ? 46 : 90,
        repeat: -1,
        ease: "none",
        transformOrigin: "50% 50%"
      });
      if (!connected) {
        gsap.set(".combo-core__glow", { scale: 1 });
        gsap.set(".combo-core__plate", { scale: 1 });
        return;
      }
      gsap.to(".combo-core__glow", {
        scale: 1.03,
        duration: Math.max(3.2, 4.6 - intensity * 1.0),
        repeat: -1,
        yoyo: true,
        ease: "sine.inOut"
      });
      gsap.to(".combo-core__plate", {
        scale: 1.006 + intensity * 0.01,
        duration: Math.max(3.6, 5 - intensity * 1.0),
        repeat: -1,
        yoyo: true,
        ease: "sine.inOut"
      });
    }, root);
    return () => context.revert();
  }, [connected, intensity, reduced]);

  useEffect(() => {
    const root = rootRef.current;
    if (!root || reduced) return undefined;
    const halos = [...root.querySelectorAll(".combo-provider-node.is-live .combo-provider-node__halo")];
    if (halos.length === 0) return undefined;
    const context = gsap.context(() => {
      halos.forEach((halo, index) => {
        gsap.fromTo(
          halo,
          { scale: 0.82, autoAlpha: 0.55 },
          {
            scale: 1.32,
            autoAlpha: 0,
            duration: 1.5,
            delay: index * 0.12,
            repeat: -1,
            ease: "power1.out"
          }
        );
      });
    }, root);
    return () => context.revert();
  }, [liveSignature, reduced]);

  useEffect(() => {
    const root = rootRef.current;
    if (!root || reduced || energyKeys.size === 0) return undefined;
    const context = gsap.context(() => {
      let index = 0;
      for (const node of layout.nodes) {
        if (!energyKeys.has(node.key)) {
          index += 1;
          continue;
        }
        const dot = root.querySelector(`[data-wire-dot="${uid}-${node.index}"]`);
        const path = root.querySelector(`[data-wire-path="${uid}-${node.index}"]`);
        if (!dot || !path || typeof path.getPointAtLength !== "function") {
          index += 1;
          continue;
        }
        const progress = { value: 1 };
        gsap.set(dot, { opacity: 0.85 });
        gsap.fromTo(
          progress,
          // Travelling from the provider edge to the center is the receive-energy
          // direction; the path mutates while dragging, so the length is read live.
          { value: 1 },
          {
            value: 0,
            duration: 2 + (index % 4) * 0.3,
            delay: index * 0.18,
            repeat: -1,
            repeatDelay: 0.8 + (index % 3) * 0.2,
            ease: "none",
            onUpdate: () => {
              const length = path.getTotalLength();
              if (!length) return;
              const point = path.getPointAtLength(length * progress.value);
              gsap.set(dot, { attr: { cx: point.x, cy: point.y } });
            }
          }
        );
        index += 1;
      }
    }, root);
    return () => context.revert();
  }, [energySignature, layout, reduced, uid]);
  const paint = useCallback(() => {
    const current = layoutRef.current;
    for (const node of current.nodes) {
      const entry = entriesRef.current.get(node.key);
      const parts = elementsRef.current.get(node.key);
      if (!entry || !parts) continue;
      setNodeTransform(parts.node, entry);
      setWirePath(parts.wire, entry, current);
    }
  }, []);

  const tick = useCallback(timestamp => {
    const current = layoutRef.current;
    const elapsed = clockRef.current ? timestamp - clockRef.current : 16;
    clockRef.current = timestamp;
    let moving = false;
    for (const node of current.nodes) {
      const entry = entriesRef.current.get(node.key);
      if (!entry) continue;
      if (!stepEntry(entry, current, elapsed, reducedRef.current)) moving = true;
    }
    paint();
    if (moving || dragRef.current) {
      frameRef.current = requestAnimationFrame(tick);
      return;
    }
    frameRef.current = 0;
    clockRef.current = 0;
  }, [paint]);

  const kick = useCallback(() => {
    // Anything that steps the springs also has to be drawn, so the frame loop is
    // woken before the "already running" shortcut.
    wake();
    if (frameRef.current) return;
    clockRef.current = 0;
    frameRef.current = requestAnimationFrame(tick);
  }, [tick, wake]);

  useEffect(() => {
    reducedRef.current = reduced;
    if (reduced && frameRef.current) {
      cancelAnimationFrame(frameRef.current);
      frameRef.current = 0;
    }
    kick();
  }, [kick, reduced]);

  useEffect(() => {
    layoutRef.current = layout;
    const root = rootRef.current;
    if (!root) return;
    const parts = new Map();
    for (const element of root.querySelectorAll(".combo-provider-node")) {
      parts.set(element.dataset.provider, { node: element, wire: null });
    }
    for (const element of root.querySelectorAll("[data-wire-path]")) {
      const node = layout.nodes.find(item => `${uid}-${item.index}` === element.dataset.wirePath);
      const holder = node ? parts.get(node.key) : null;
      if (holder) holder.wire = element;
    }
    elementsRef.current = parts;
    syncEntries(entriesRef.current, layout);
    kick();
  }, [kick, layout, uid]);

  useEffect(() => () => {
    if (frameRef.current) cancelAnimationFrame(frameRef.current);
    frameRef.current = 0;
    clockRef.current = 0;
    dragRef.current = null;
    if (typeof window !== "undefined") window.clearTimeout(sleepTimerRef.current);
  }, []);

  useEffect(() => {
    // A real availability result or a real run event changes what is drawn, so it
    // has to wake the loop even when nothing was dragged.
    wake();
  }, [wake, statusById, liveById, runActive, size.width, size.height]);

  function localPoint(event) {
    const rect = rootRef.current?.getBoundingClientRect();
    if (!rect) return null;
    return { x: event.clientX - rect.left, y: event.clientY - rect.top };
  }

  function beginNodeDrag(event, node) {
    const entry = entriesRef.current.get(node.key);
    const point = localPoint(event);
    if (!entry || !point) return;
    entry.dragging = true;
    dragMovedRef.current = false;
    dragRef.current = {
      key: node.key,
      startX: point.x,
      startY: point.y,
      offsetX: entry.node.x - point.x,
      offsetY: entry.node.y - point.y
    };
    event.currentTarget.classList.add("is-dragging");
    event.currentTarget.setPointerCapture?.(event.pointerId);
    setHasCustomPositions(true);
    kick();
  }

  function moveNodeDrag(event) {
    const drag = dragRef.current;
    if (!drag) return;
    const entry = entriesRef.current.get(drag.key);
    const point = localPoint(event);
    if (!entry || !point) return;
    if (Math.hypot(point.x - drag.startX, point.y - drag.startY) > 4) dragMovedRef.current = true;
    moveEntry(entry, point.x + drag.offsetX, point.y + drag.offsetY, layoutRef.current, reducedRef.current);
    if (reducedRef.current) paint();
    else kick();
  }

  function endNodeDrag(event) {
    const drag = dragRef.current;
    if (!drag) return;
    dragRef.current = null;
    event.currentTarget.classList.remove("is-dragging");
    if (event.currentTarget.hasPointerCapture?.(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    const entry = entriesRef.current.get(drag.key);
    if (!entry) return;
    entry.dragging = false;
    kick();
  }

  function nudgeNode(event, node) {
    const entry = entriesRef.current.get(node.key);
    if (!entry) return;
    const step = event.shiftKey ? KEYBOARD_STEP_MAJOR : KEYBOARD_STEP;
    const deltas = {
      ArrowLeft: [-step, 0],
      ArrowRight: [step, 0],
      ArrowUp: [0, -step],
      ArrowDown: [0, step]
    };
    const delta = deltas[event.key];
    if (delta) {
      event.preventDefault();
      // Nudge from the position the node is heading for, not the position it is
      // still animating through, so two quick key presses add up.
      moveEntry(
        entry,
        entry.node.targetX + delta[0],
        entry.node.targetY + delta[1],
        layoutRef.current,
        reducedRef.current
      );
      setHasCustomPositions(true);
      kick();
      return;
    }
    if (event.key === "Enter" || event.key === " ") {
      // Keyboard activation has to do what a click does: the primary action of
      // this control is the one the pointer gets, not the housekeeping shortcut.
      event.preventDefault();
      selectProvider(node);
      return;
    }
    if (event.key === "Escape") {
      event.preventDefault();
      resetEntry(entry, layoutRef.current, reducedRef.current);
      kick();
    }
  }

  function selectProvider(node) {
    onProviderSelect?.(node.provider);
  }

  function resetNode(node) {
    const entry = entriesRef.current.get(node.key);
    if (!entry) return;
    resetEntry(entry, layoutRef.current, reducedRef.current);
    kick();
  }

  function resetNetworkLayout() {
    for (const entry of entriesRef.current.values()) {
      resetEntry(entry, layoutRef.current, reducedRef.current);
    }
    setHasCustomPositions(false);
    kick();
  }

  // Plain text, no animated digits: a live region has to announce one settled
  // sentence, not every frame of a counter rolling up to it. Only the buckets a
  // run has actually entered are named, so a queued provider is not reported as
  // a run where nothing is happening.
  const runTally = [
    counts.starting > 0 ? `${counts.starting} starting` : null,
    counts.running > 0 ? `${counts.running} answering` : null,
    counts.completed > 0 ? `${counts.completed} answered` : null,
    counts.failed > 0 ? `${counts.failed} failed` : null
  ].filter(Boolean).join(", ");

  const description = providers.length === 0
    ? "Vups Combo AI provider network. No models selected."
    : `Vups Combo AI provider network. ${providers.length} provider${providers.length === 1 ? "" : "s"} linked, ${summary.working} available.${runActive ? ` ${runTally}.` : ""}`;

  const statusLabel = status => (status === "working" ? "available" : status === "not_working" ? "not available" : "status unknown");

  const statusSentence = providers.length === 0
    ? "No providers linked. Select models from the library."
    : `${providers.length} provider${providers.length === 1 ? "" : "s"} linked, ${summary.working} available${
      runActive ? `, ${runTally}` : ""
    }.`;

  function nodeLabel(node) {
    const status = statusById.get(node.key) || "unknown";
    const live = liveById.get(node.key);
    const activity = live ? `, ${live === "working" ? "answering now" : live === "done" ? "answered" : live === "failed" ? "request failed" : "queued"}` : "";
    return `${node.provider.name} provider node, ${statusLabel(status)}${activity}. Activate to show this provider in the model library. Drag or use arrow keys to reposition, Escape or double click to return it to the default position.`;
  }

  const machineOn = machineEnabled && providers.length > 0;

  return (
    <div
      ref={rootRef}
      className={`combo-core${reduced ? " combo-core--still" : ""}${machineOn ? " combo-core--3d" : ""}`}
      data-connected={connected ? "true" : "false"}
      data-renderer={machineOn ? "webgl" : "dom"}
      style={{
        "--combo-intensity": intensity.toFixed(2),
        "--combo-connected": connected ? "1" : "0",
        "--combo-center-size": `${layout.centerSize}px`,
        "--combo-node-size": `${layout.nodeSize}px`
      }}
    >
      <div
        className="combo-core__network"
        role="group"
        aria-label={description}
        onPointerMove={event => {
          const point = localPoint(event);
          if (point) {
            pointerRef.current = point;
            // Parallax is the one thing the machine draws that has no spring of
            // its own, so a moving pointer has to wake the loop by itself.
            wake();
          }
        }}
        onPointerLeave={() => {
          // Leaving the stage has to relax the lean, or the last pointer position
          // would hold the housing tilted indefinitely.
          pointerRef.current = null;
          wake();
        }}
      >
        <div className="combo-core__ambient" aria-hidden="true" />
        {machineOn ? (
          <Suspense fallback={null}>
            <ComboMachine3D
              layout={layout}
              entriesRef={entriesRef}
              statusById={statusById}
              liveById={liveById}
              interactionRef={interactionRef}
              pointerRef={pointerRef}
              coreState={machineCore}
              startupRef={activeStartupRef}
              selectedId={activeProviderId}
              quality={quality}
              visible={machineInView && documentVisible}
              // A run in flight is continuous animation: the pulse schedule only
              // reads correctly if the loop stays open until it actually ends.
              awake={awake || startupRunning || runActive}
              onContextLost={() => {
                // A lost context must degrade to the 2D machine, not to a black box.
                // Only this mount is switched off, and the capability probe is
                // invalidated rather than falsified: react-three-fiber calls
                // forceContextLoss() while tearing its own canvas down, and
                // caching that as "no WebGL" would leave Apex in its 2D fallback
                // for the rest of the session. The next entry probes again.
                webglProbe = null;
                setMachineEnabled(false);
              }}
            />
          </Suspense>
        ) : null}
        <svg
          className="combo-core__wires"
          viewBox={`0 0 ${layout.width} ${layout.height}`}
          preserveAspectRatio="none"
          aria-hidden="true"
          focusable="false"
        >
          {layout.nodes.map(node => {
            const status = statusById.get(node.key) || "unknown";
            const live = liveById.get(node.key);
            const pathId = `${uid}-${node.index}`;
            const energized = energyKeys.has(node.key);
            return (
              <g
                key={node.key}
                className={`combo-wire status-${status}${live ? ` live-${live}` : ""}`}
                data-provider={node.key}
              >
                <path
                  id={`wire-${pathId}`}
                  data-wire-path={pathId}
                  d={node.wire}
                  className="combo-wire__line"
                />
                {energized ? (
                  <circle
                    data-wire-dot={pathId}
                    className="combo-wire__dot"
                    r="2.6"
                    cx={layout.center.x}
                    cy={layout.center.y}
                  />
                ) : null}
              </g>
            );
          })}
        </svg>

        <div
          className="combo-core__center"
          aria-hidden="true"
          style={{
            left: `${(layout.center.x / layout.width) * 100}%`,
            top: `${(layout.center.y / layout.height) * 100}%`
          }}
        >
          <span className="combo-core__glow" />
          <span className="combo-core__plate">
            <span className="combo-core__groove" />
            <VupsLogo className="combo-core__logo" sizes={`${layout.centerSize}px`} />
          </span>
        </div>

        {layout.nodes.map(node => {
          const status = statusById.get(node.key) || "unknown";
          const live = liveById.get(node.key);
          return (
            <div
              key={node.key}
              className={`combo-provider-node combo-provider-node--${layout.density}${live === "working" ? " is-live" : ""}${live === "done" ? " is-done" : ""}${live === "failed" ? " is-failed" : ""}`}
              style={{ left: `${node.xPct}%`, top: `${node.yPct}%` }}
              data-provider={node.key}
              data-status={status}
              data-activity={live || "idle"}
              role="button"
              tabIndex={0}
              aria-label={nodeLabel(node)}
              onPointerDown={event => beginNodeDrag(event, node)}
              onPointerMove={moveNodeDrag}
              onPointerUp={endNodeDrag}
              onPointerCancel={endNodeDrag}
              onPointerEnter={() => { interactionRef.current.hovered = node.key; }}
              onPointerLeave={() => { interactionRef.current.hovered = null; }}
              onFocus={() => { interactionRef.current.focused = node.key; }}
              onBlur={() => { if (interactionRef.current.focused === node.key) interactionRef.current.focused = null; }}
              onDoubleClick={() => resetNode(node)}
              onKeyDown={event => nudgeNode(event, node)}
              onClick={() => {
                // The guard is spent by the click it was armed for: leaving it
                // raised would swallow the next genuine selection.
                if (dragMovedRef.current) {
                  dragMovedRef.current = false;
                  return;
                }
                selectProvider(node);
              }}
              data-selected={activeProviderId === node.key ? "true" : undefined}
            >
              <span className="combo-provider-node__halo" />
              <span className="combo-provider-node__disc">
                <ProviderMark art={node.provider.artwork} />
              </span>
              {node.provider.artwork.type === "wordmark" ? null : (
                <span
                  className="combo-provider-node__label"
                  data-side={Math.sin(node.angle) < -0.3 ? "above" : "below"}
                  data-align={node.xPct < 20 ? "start" : node.xPct > 80 ? "end" : "center"}
                >
                  {node.provider.name}
                </span>
              )}
            </div>
          );
        })}

        {providers.length === 0 ? (
          <p className="combo-core__empty">Select models from the library to light the network.</p>
        ) : null}
      </div>

      {hasCustomPositions ? (
        <button
          type="button"
          className="combo-core__reset"
          onClick={resetNetworkLayout}
          onPointerDown={event => event.stopPropagation()}
          aria-label="Reset provider positions to the default layout"
          title="Reset provider positions"
        >
          <HugeiconsIcon icon={RefreshIcon} size={13} strokeWidth={2} />
        </button>
      ) : null}

      <p className="combo-core__note" aria-hidden="true">
        Visual participation, not a CPU/GPU power measurement.
      </p>
      <div className="combo-core__status">
        <span className="combo-core__sr" role="status" aria-live="polite">{statusSentence}</span>
        <span className="combo-core__readout" aria-hidden="true">
          <span className="combo-core__status-dot" data-active={summary.working > 0 ? "true" : "false"} />
          {providers.length === 0 ? (
            <span className="combo-core__metric">No providers linked</span>
          ) : (
            <>
              <span className="combo-core__metric">
                <span className="combo-core__count">{providers.length}</span>
                <span>{providers.length === 1 ? " provider" : " providers"} linked</span>
              </span>
              <span className="combo-core__status-sep">·</span>
              <span className="combo-core__metric">
                <span className="combo-core__count">{summary.working}</span>
                <span>available</span>
              </span>
              {runActive ? (
                <>
                  <span className="combo-core__status-sep">·</span>
                  <span className="combo-core__metric combo-core__status-run">
                    {counts.running > 0 ? (
                      <>
                        <span className="combo-core__count">{counts.running}</span>
                        <span>answering now</span>
                      </>
                    ) : counts.failed > 0 ? (
                      <>
                        <span className="combo-core__count">{counts.failed}</span>
                        <span>failed</span>
                      </>
                    ) : (
                      <span>dispatching request</span>
                    )}
                  </span>
                </>
              ) : null}
            </>
          )}
        </span>
      </div>
    </div>
  );
}
