import { useEffect, useRef } from "react";
import { gsap } from "gsap";
import { ScrollTrigger } from "gsap/ScrollTrigger";
import Lenis from "lenis";

gsap.registerPlugin(ScrollTrigger);

// Lenis replaces the browser's own smooth scrolling, so it has to own the
// scroll position outright: it runs on GSAP's single ticker (no second RAF of
// its own), it pushes every change into ScrollTrigger, and the stylesheet's
// `scroll-behavior: smooth` is switched off while it is alive so the two
// animations cannot fight over the same scroll write.
export function useLenisScroll({ enabled = false, duration = 1.02 } = {}) {
  const lenisRef = useRef(null);

  useEffect(() => {
    if (!enabled) return undefined;
    const root = document.documentElement;
    const previousBehavior = root.style.scrollBehavior;
    const previousPriority = root.style.getPropertyPriority("scroll-behavior");

    let lenis = null;
    try {
      lenis = new Lenis({
        autoRaf: false,
        smoothWheel: true,
        duration,
        easing: t => Math.min(1, 1.001 - Math.pow(2, -10 * t))
      });
    } catch {
      return undefined;
    }

    lenisRef.current = lenis;
    root.style.setProperty("scroll-behavior", "auto", "important");
    const onScroll = () => ScrollTrigger.update();
    lenis.on("scroll", onScroll);
    const render = time => lenis.raf(time * 1000);
    gsap.ticker.add(render);
    gsap.ticker.lagSmoothing(0);

    const refresh = () => ScrollTrigger.refresh();
    window.addEventListener("resize", refresh);
    window.addEventListener("orientationchange", refresh);
    let watched = false;
    const watchImages = () => {
      if (watched) return;
      watched = true;
      for (const img of document.images) {
        if (!img.complete) {
          img.addEventListener("load", refresh, { once: true });
          img.addEventListener("error", refresh, { once: true });
        }
      }
    };
    // Metrics change once the real faces and the first screenshots land.
    document.fonts?.ready.then(watchImages).catch(() => {});
    const idle = window.requestAnimationFrame(() => {
      refresh();
      watchImages();
    });

    return () => {
      window.cancelAnimationFrame(idle);
      window.removeEventListener("resize", refresh);
      window.removeEventListener("orientationchange", refresh);
      gsap.ticker.remove(render);
      lenis.off("scroll", onScroll);
      lenis.destroy();
      lenisRef.current = null;
      if (previousBehavior) root.style.setProperty("scroll-behavior", previousBehavior, previousPriority);
      else root.style.removeProperty("scroll-behavior");
      ScrollTrigger.refresh();
    };
  }, [enabled, duration]);

  return lenisRef;
}

// Anchor and rail navigation keeps working: the destination is still the real
// element, only the travel is smoothed, and the header offset is preserved.
export function scrollToStageSection(lenisRef, id) {
  const target = document.getElementById(id);
  if (!target) return false;
  const lenis = lenisRef?.current;
  if (lenis) {
    lenis.scrollTo(target, { offset: -84, duration: 1.1 });
    return true;
  }
  target.scrollIntoView({ behavior: "smooth", block: "start" });
  return true;
}
