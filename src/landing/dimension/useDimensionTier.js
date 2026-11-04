import { useEffect, useMemo, useState } from "react";

/* Is a 3D scene even a possibility on this machine — decided without loading it.

   This module is imported by the page shell, so it must never pull in three.js:
   it is the layer that decides whether the WebGL chunk is worth fetching at all.
   A visitor with no GL context, a coarse pointer, a narrow window, or a
   reduced-motion preference gets the static composition, and the bundle for the
   canvas is never downloaded for them.

   That decision is about the three.js scene only. The ReactBits Metallic Paint
   logo is a WebGL2 quad with no three.js in it, so it is gated on `hasWebgl2`
   instead — a phone or a narrow window loses the scene, not the logo. */

export const NARROW_BREAKPOINT = 760;
export const MEDIUM_BREAKPOINT = 1180;
export const MAX_DPR = 1.5;

export function hasWebgl(scope = typeof window === "undefined" ? null : window) {
  if (!scope?.document) return false;
  try {
    const probe = scope.document.createElement("canvas");
    const gl = probe.getContext("webgl2") || probe.getContext("webgl");
    if (!gl) return false;
    /* The probe exists to answer one question, and a live context is a scarce
       browser resource (browsers cap them at a handful). Losing it here keeps a
       visit to the home page from costing a context the 3D stage then needs. */
    gl.getExtension("WEBGL_lose_context")?.loseContext();
    return true;
  } catch {
    return false;
  }
}

/** The logo surface is a plain WebGL2 shader on a single quad, so its requirement
    is narrower than the scene's and is answered separately: a machine that gets
    the flat composition still gets the real Metallic Paint logo when it can run
    one. */
export function hasWebgl2(scope = typeof window === "undefined" ? null : window) {
  if (!scope?.document) return false;
  try {
    const probe = scope.document.createElement("canvas");
    const gl = probe.getContext("webgl2");
    if (!gl) return false;
    gl.getExtension("WEBGL_lose_context")?.loseContext();
    return true;
  } catch {
    return false;
  }
}

/** The three machines this page actually meets. Each tier is a complete
    composition of its own, not a desktop scene with things switched off.
    `webgl` here means "this composition carries the 3D scene" — it is not a
    capability report, and the logo surface must not be gated on it. */
export function dimensionTier({
  width = 1440,
  reducedMotion = false,
  coarse = false,
  webgl = true
} = {}) {
  if (!webgl || coarse || reducedMotion || width < NARROW_BREAKPOINT) {
    return { webgl: false, motion: false, dpr: 1, shadows: false, limitPerGroup: 0 };
  }
  if (width < MEDIUM_BREAKPOINT) {
    return { webgl: true, motion: true, dpr: 1.25, shadows: false, limitPerGroup: 3 };
  }
  return { webgl: true, motion: true, dpr: MAX_DPR, shadows: true, limitPerGroup: Infinity };
}

function readStageViewport(webglAvailable = true) {
  if (typeof window === "undefined") {
    return dimensionTier({ webgl: false });
  }
  return dimensionTier({
    width: window.innerWidth,
    coarse: window.matchMedia("(pointer: coarse)").matches,
    reducedMotion: window.matchMedia("(prefers-reduced-motion: reduce)").matches,
    webgl: webglAvailable
  });
}

export function useDimensionTier() {
  const webgl = useMemo(() => hasWebgl(), []);
  const webgl2 = useMemo(() => hasWebgl2(), []);
  const [state, setState] = useState(() => ({
    tier: readStageViewport(webgl),
    reducedMotion: typeof window !== "undefined"
      && window.matchMedia("(prefers-reduced-motion: reduce)").matches
  }));

  useEffect(() => {
    const sync = () => setState({
      tier: readStageViewport(webgl),
      reducedMotion: window.matchMedia("(prefers-reduced-motion: reduce)").matches
    });
    sync();
    const queries = [
      window.matchMedia("(pointer: coarse)"),
      window.matchMedia("(prefers-reduced-motion: reduce)")
    ];
    window.addEventListener("resize", sync);
    window.addEventListener("orientationchange", sync);
    for (const query of queries) query.addEventListener("change", sync);
    return () => {
      window.removeEventListener("resize", sync);
      window.removeEventListener("orientationchange", sync);
      for (const query of queries) query.removeEventListener("change", sync);
    };
  }, [webgl]);

  return { tier: state.tier, webgl, webgl2, reducedMotion: state.reducedMotion };
}
