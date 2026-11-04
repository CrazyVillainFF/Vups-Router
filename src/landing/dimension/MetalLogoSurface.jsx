import { useEffect, useState } from "react";
import MetallicPaint from "../../components/reactbits/MetallicPaint/MetallicPaint.jsx";
import { hasWebgl2 } from "./useDimensionTier.js";
import { METAL_LOGO_SRC, METAL_PAINT } from "./MetallicLogoOverlay.jsx";

/* The same ReactBits Metallic Paint surface, for the composition that has no
   three.js scene in it.

   The tracked logo inside the stage is positioned by the plate every frame; this
   one is placed by CSS and sized by `--vd-mark`, so it needs no scene to exist.
   It is what a phone, a narrow window or a reduced-motion preference gets in
   place of the flat SVG mark — the real component, not a picture of it.

   The two probes answer separately and report which one failed, because the page
   prints the answer: a machine without WebGL2 and a missing logo file are
   different facts and need different fallbacks named differently. */

/** The logo fills this fraction of its box — the same fraction the plate's own
    projected size hands the tracked surface at the hero pose. */
const SURFACE_SCALE = 0.62;

/** The two states that mean the surface cannot run here, each for a reason the
    page can name: no WebGL2 to compile the shader in, or no logo file to draw. */
export const METAL_PAINT_FAILED = ["no-webgl2", "no-asset"];

function logoLoads(src) {
  return new Promise(resolve => {
    const image = new Image();
    image.onload = () => resolve(true);
    image.onerror = () => resolve(false);
    image.src = src;
  });
}

export default function MetalLogoSurface({ motion = true, onState, children }) {
  const [state, setState] = useState("pending");

  useEffect(() => {
    if (!hasWebgl2()) {
      setState("no-webgl2");
      return undefined;
    }
    let alive = true;
    logoLoads(METAL_LOGO_SRC).then(ok => {
      if (alive) setState(ok ? "live" : "no-asset");
    });
    return () => {
      alive = false;
    };
  }, []);

  useEffect(() => {
    if (state !== "pending") onState?.(state);
  }, [onState, state]);

  /* Only a verified failure hands back the flat mark. While the probes are still
     answering, the sized box is already in the layout, so a machine that can run
     the surface never paints the SVG first. */
  if (METAL_PAINT_FAILED.includes(state)) return children ?? null;

  return (
    <div className="vd-poster__metal" aria-hidden="true">
      {state === "live" ? (
        <MetallicPaint
          {...METAL_PAINT}
          scale={SURFACE_SCALE}
          speed={motion ? 1 : 0}
          intro={motion}
          paused={!motion}
        />
      ) : null}
    </div>
  );
}
