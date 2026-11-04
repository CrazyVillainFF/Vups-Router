import { useEffect, useRef, useState } from "react";
import MetallicPaint from "../../components/reactbits/MetallicPaint/MetallicPaint.jsx";
import { hasWebgl2 } from "./useDimensionTier.js";

/* The ReactBits Metallic Paint surface that carries the Vups logo.

   The component itself is the official ReactBits implementation, copied verbatim
   into src/components/reactbits/MetallicPaint/ beside the project's other vendored
   ReactBits source. This module is only the glue the dimensional stage
   needs: a fixed-size host box that the WebGL scene repositions every frame, and
   the two probes that decide whether the liquid-metal logo can run at all.

   The host box keeps its own size. MetallicPaint measures its container with
   getBoundingClientRect() and reallocates its drawing buffer whenever that size
   changes, so a host that scaled or rotated with the plate would rebuild its
   canvas every frame and flicker. A translate does not change the measured box,
   so the stage writes translate3d only, and hands the plate's apparent size to the
   shader through the component's documented `scale` prop. */

export const METAL_LOGO_SRC = "/vups-logo-transparent.png";

/** The one setting table the logo is drawn with, shared by the surface that rides
    the plate and the flat composition's `MetalLogoSurface`, so the two cannot
    drift into two different-looking logos. `scale` is deliberately absent: the
    tracked surface takes it from the plate's projected size, the flat one from
    its own box. */
export const METAL_PAINT = {
  imageSrc: METAL_LOGO_SRC,
  density: 4,
  mouseTilt: 0
};

function logoLoads(src) {
  return new Promise(resolve => {
    const image = new Image();
    image.onload = () => resolve(true);
    image.onerror = () => resolve(false);
    image.src = src;
  });
}

export default function MetallicLogoOverlay({ motion = true, hostRef, apiRef, onActive }) {
  const [scale, setScale] = useState(0.6);
  const live = useRef(false);

  useEffect(() => {
    apiRef.current = {
      setScale(next) {
        setScale(current => (Math.abs(next - current) < 0.0025 ? current : next));
      }
    };
    return () => {
      apiRef.current = null;
    };
  }, [apiRef]);

  useEffect(() => {
    if (!hasWebgl2()) {
      onActive(false);
      return undefined;
    }
    let alive = true;
    /* A missing asset must not leave the frame holding an empty canvas: the
       stage is told to keep the extruded logo instead. */
    logoLoads(METAL_LOGO_SRC).then(ok => {
      if (!alive) return;
      live.current = ok;
      onActive(ok);
    });
    return () => {
      alive = false;
      if (!live.current) return;
      live.current = false;
      onActive(false);
    };
  }, [onActive]);

  return (
    <div className="vd-metal" ref={hostRef} aria-hidden="true">
      {live.current ? (
        <MetallicPaint
          {...METAL_PAINT}
          scale={scale}
          speed={motion ? 1 : 0}
          intro={motion}
          paused={!motion}
        />
      ) : null}
    </div>
  );
}
