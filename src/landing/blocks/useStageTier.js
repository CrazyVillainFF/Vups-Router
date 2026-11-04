import { useEffect, useMemo, useState } from "react";
import { stageTier } from "./blockStageLayout.js";

// Loaded from the main chunk, so it must never import three.js: this is the
// layer that decides whether the WebGL chunk is worth fetching at all.

export function supportsWebgl() {
  try {
    const probe = document.createElement("canvas");
    return Boolean(probe.getContext("webgl2") || probe.getContext("webgl"));
  } catch {
    return false;
  }
}

function readViewport() {
  if (typeof window === "undefined") return { width: 1440, coarse: false, reduced: false };
  return {
    width: window.innerWidth,
    coarse: window.matchMedia("(pointer: coarse)").matches,
    reduced: window.matchMedia("(prefers-reduced-motion: reduce)").matches
  };
}

export function useStageTier() {
  const [viewport, setViewport] = useState(readViewport);
  const webgl = useMemo(() => supportsWebgl(), []);

  useEffect(() => {
    const queries = [window.matchMedia("(pointer: coarse)"), window.matchMedia("(prefers-reduced-motion: reduce)")];
    const sync = () => setViewport(readViewport());
    sync();
    window.addEventListener("resize", sync);
    window.addEventListener("orientationchange", sync);
    for (const query of queries) query.addEventListener("change", sync);
    return () => {
      window.removeEventListener("resize", sync);
      window.removeEventListener("orientationchange", sync);
      for (const query of queries) query.removeEventListener("change", sync);
    };
  }, []);

  return { tier: stageTier({ ...viewport, webgl }), viewport, webgl };
}

export function usePageVisible() {
  const [visible, setVisible] = useState(() => (typeof document === "undefined" ? true : document.visibilityState !== "hidden"));
  useEffect(() => {
    const sync = () => setVisible(document.visibilityState !== "hidden");
    document.addEventListener("visibilitychange", sync);
    return () => document.removeEventListener("visibilitychange", sync);
  }, []);
  return visible;
}
