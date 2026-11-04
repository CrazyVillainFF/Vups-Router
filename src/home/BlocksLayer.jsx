import React, { Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { motion } from "motion/react";
import { disposeFaces, paletteFor } from "./blocksMaterials.js";
import { qualityTier } from "./blocksLayout.js";
import { blockAnchor, handoffBlockFor } from "./modelBlocks.js";

const HANDOFF_MS = 400;
// Imported only when the layer is going to draw with WebGL, so phones and
// software-rendered shells never pay for the three.js chunk.
const ModelBlockScene = React.lazy(() => import("./ModelBlockScene.jsx"));

function supportsWebgl() {
  try {
    const canvas = document.createElement("canvas");
    return Boolean(canvas.getContext("webgl2") || canvas.getContext("webgl"));
  } catch {
    return false;
  }
}

function useHomeTier() {
  const read = () => ({
    width: typeof window === "undefined" ? 1440 : window.innerWidth,
    coarse: typeof window === "undefined" ? false : window.matchMedia("(pointer: coarse)").matches,
    reduced:
      typeof window === "undefined"
        ? false
        : window.matchMedia("(prefers-reduced-motion: reduce)").matches
  });
  const [viewport, setViewport] = useState(read);

  useEffect(() => {
    const media = [
      window.matchMedia("(pointer: coarse)"),
      window.matchMedia("(prefers-reduced-motion: reduce)")
    ];
    const sync = () => setViewport(read());
    sync();
    window.addEventListener("resize", sync);
    for (const query of media) query.addEventListener("change", sync);
    return () => {
      window.removeEventListener("resize", sync);
      for (const query of media) query.removeEventListener("change", sync);
    };
  }, []);

  const webgl = useMemo(() => supportsWebgl(), []);
  const mode = !webgl || viewport.coarse || viewport.width < 760 ? "list" : "scene";
  return { mode, motion: mode === "scene" && !viewport.reduced, webgl, viewport };
}

function usePageVisible() {
  const [visible, setVisible] = useState(() =>
    typeof document === "undefined" ? true : document.visibilityState !== "hidden"
  );
  useEffect(() => {
    const sync = () => setVisible(document.visibilityState !== "hidden");
    document.addEventListener("visibilitychange", sync);
    return () => document.removeEventListener("visibilitychange", sync);
  }, []);
  return visible;
}

export default function BlocksLayer({
  blocks,
  theme = "dark",
  activeKey,
  onSelect,
  handoff,
  fading = false,
  dim = false
}) {
  const rootRef = useRef(null);
  const pointerRef = useRef({ x: 0, y: 0 });
  const handoffRef = useRef(null);
  const cursorRef = useRef(null);
  const [hovered, setHovered] = useState("");
  const [handoffToken, setHandoffToken] = useState(0);
  const [handoffActive, setHandoffActive] = useState(false);
  const { mode, motion: allowMotion, viewport } = useHomeTier();
  const visible = usePageVisible();
  const palette = useMemo(() => paletteFor(theme), [theme]);
  const tierBase = useMemo(
    () =>
      qualityTier({
        width: viewport.width,
        reducedMotion: viewport.reduced,
        coarse: viewport.coarse
      }),
    [viewport.width, viewport.reduced, viewport.coarse]
  );
  // A hidden tab stops the idle loop but must not cut a handoff mid-draw; the
  // request that started it is already on its way to the provider.
  const tier = useMemo(
    () => ({ ...tierBase, motion: tierBase.motion && visible }),
    [tierBase, visible]
  );

  // Face textures live in a module cache outside the React tree.
  useEffect(() => () => disposeFaces(), [theme]);

  useEffect(() => {
    const previous = handoffRef.current;
    handoffRef.current = null;
    const block = handoff && allowMotion ? handoffBlockFor(blocks, handoff) : null;
    if (!block) {
      if (previous) {
        setHandoffToken(current => current + 1);
        setHandoffActive(false);
      }
      return undefined;
    }
    const root = rootRef.current;
    const composer = root?.closest(".vr-chat-layout")?.querySelector(".vr-composer");
    if (root && composer) {
      const box = root.getBoundingClientRect();
      const bar = composer.getBoundingClientRect();
      handoffRef.current = {
        block,
        sizeScale: tier.sizeScale,
        t0: performance.now(),
        anchor: {
          x: Math.max(8, Math.min(box.width - 8, box.width * 0.5)),
          y: Math.max(8, box.height + (box.bottom - bar.top))
        }
      };
    } else {
      handoffRef.current = {
        block,
        sizeScale: tier.sizeScale,
        t0: performance.now(),
        anchor: null
      };
    }
    setHandoffToken(current => current + 1);
    setHandoffActive(true);
    const timer = window.setTimeout(() => {
      handoffRef.current = null;
      setHandoffToken(current => current + 1);
      setHandoffActive(false);
    }, HANDOFF_MS + 60);
    return () => window.clearTimeout(timer);
  }, [handoff, blocks, allowMotion, tier.sizeScale]);

  // The shelf box itself is pointer-events:none so the page under it stays
  // clickable, which means a React onPointerMove on it only ever fires when the
  // pointer happens to cross a hit target. The ring then sits at its default
  // top-left forever. Tracking the window instead is what makes it follow.
  useEffect(() => {
    if (!allowMotion || mode !== "scene") return undefined;
    const node = cursorRef.current;
    let frame = 0;
    let next = null;

    const flush = () => {
      frame = 0;
      const root = rootRef.current;
      if (!node || !root || !next) return;
      const box = root.getBoundingClientRect();
      if (!box.width || !box.height) return;
      node.style.transform = `translate3d(${next.x - box.left}px, ${next.y - box.top}px, 0)`;
      const inside =
        next.x >= box.left && next.x <= box.right && next.y >= box.top && next.y <= box.bottom;
      if (inside) {
        pointerRef.current = {
          x: ((next.x - box.left) / box.width) * 2 - 1,
          y: ((next.y - box.top) / box.height) * 2 - 1
        };
      }
    };

    const onMove = event => {
      next = { x: event.clientX, y: event.clientY };
      if (node) node.setAttribute("data-visible", "");
      if (!frame) frame = window.requestAnimationFrame(flush);
    };
    const hide = () => {
      if (node) node.removeAttribute("data-visible");
    };

    window.addEventListener("pointermove", onMove, { passive: true });
    window.addEventListener("pointerup", onMove, { passive: true });
    document.addEventListener("pointerleave", hide);
    document.documentElement.addEventListener("pointerleave", hide);
    window.addEventListener("blur", hide);
    return () => {
      if (frame) window.cancelAnimationFrame(frame);
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onMove);
      document.removeEventListener("pointerleave", hide);
      document.documentElement.removeEventListener("pointerleave", hide);
      window.removeEventListener("blur", hide);
      hide();
    };
  }, [allowMotion, mode]);

  // A face texture is baked once. If the webfont lands after the first bake, the
  // engraving is stuck with fallback metrics, so the cache is dropped and the
  // auto-fit runs again against the real font.
  const [fontEpoch, setFontEpoch] = useState(0);
  useEffect(() => {
    const fonts = document.fonts;
    if (!fonts?.ready) return undefined;
    let cancelled = false;
    fonts.ready.then(() => {
      if (cancelled) return;
      disposeFaces();
      setFontEpoch(current => current + 1);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const select = useCallback(
    (block, event) => {
      event?.preventDefault?.();
      onSelect?.(block.row);
    },
    [onSelect]
  );

  if (!blocks || blocks.length === 0) return null;
  const shown = hovered ? blocks.find(block => block.key === hovered) : null;

  return (
    <div
      className="vr-blocks"
      ref={rootRef}
      data-mode={mode}
      data-motion={allowMotion ? "on" : "off"}
      data-fading={fading ? "on" : undefined}
      data-dim={dim ? "on" : undefined}
    >
      {mode === "scene" ? (
        <Suspense fallback={null}>
          <motion.div
            className="vr-blocks-canvas"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            transition={{ duration: 0.22, ease: "easeOut" }}
          >
            <ModelBlockScene
              blocks={blocks}
              palette={palette}
              tier={tier}
              visible={visible}
              rendering={handoffActive}
              hoveredKey={hovered}
              fontEpoch={fontEpoch}
              pointerRef={pointerRef}
              handoffRef={handoffRef}
              handoffToken={handoffToken}
            />
          </motion.div>
        </Suspense>
      ) : null}

      <div className="vr-blocks-hits">
        {blocks.map(block => {
          const anchor = blockAnchor(block);
          return (
            <button
              key={block.key}
              type="button"
              className="vr-block-hit"
              data-active={block.key === activeKey ? "" : undefined}
              style={{
                left: `${anchor.x * 100}%`,
                top: `${anchor.y * 100}%`,
                width: `${17 * anchor.scale}%`
              }}
              onMouseEnter={() => setHovered(block.key)}
              onMouseLeave={() => setHovered(current => (current === block.key ? "" : current))}
              onFocus={() => setHovered(block.key)}
              onBlur={() => setHovered(current => (current === block.key ? "" : current))}
              onClick={event => select(block, event)}
              aria-pressed={block.key === activeKey}
              title={`${block.name}${block.model ? ` - ${block.model}` : ""}`}
            >
              <span className="vr-block-hit__label">{block.name}</span>
            </button>
          );
        })}
      </div>

      {mode === "list" ? (
        <ul className="vr-blocks-list" role="list">
          {blocks.map(block => (
            <li key={block.key}>
              <button
                type="button"
                className="vr-blocks-list__row"
                data-active={block.key === activeKey ? "" : undefined}
                onClick={event => select(block, event)}
                onMouseEnter={() => setHovered(block.key)}
                onFocus={() => setHovered(block.key)}
                onMouseLeave={() => setHovered("")}
                onBlur={() => setHovered("")}
              >
                <span className="vr-blocks-list__name">{block.name}</span>
                <span className="vr-blocks-list__model">{block.model}</span>
              </button>
            </li>
          ))}
        </ul>
      ) : null}

      <div className="vr-block-card" data-open={shown ? "" : undefined} aria-live="polite">
        {shown ? (
          <>
            <strong className="vr-block-card__name">{shown.name}</strong>
            <span className="vr-block-card__model">{shown.model}</span>
            {shown.provider ? (
              <span className="vr-block-card__line">
                <b>{shown.provider}</b>
                {shown.tag ? ` - ${shown.tag}` : ""}
              </span>
            ) : null}
            {shown.meta ? <span className="vr-block-card__meta">{shown.meta}</span> : null}
            {shown.capabilities?.length ? (
              <span className="vr-block-card__caps">{shown.capabilities.join(" / ")}</span>
            ) : null}
          </>
        ) : (
          <span className="vr-block-card__idle">Point at a block for the model behind it</span>
        )}
      </div>

      {allowMotion && mode === "scene" ? (
        <span
          className="vr-block-cursor"
          data-on={shown ? "" : undefined}
          ref={cursorRef}
          aria-hidden="true"
        />
      ) : null}
    </div>
  );
}
