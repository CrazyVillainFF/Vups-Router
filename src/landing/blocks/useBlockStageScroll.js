import { useEffect, useRef, useState } from "react";
import { ScrollTrigger } from "gsap/ScrollTrigger";
import { scrollTimelineConfig, stageSectionOrder } from "./scrollTimelineConfig.js";

// The scroll film reads one value: a pose. Every section trigger writes the
// same shape into a ref that the WebGL scene samples per frame, so no scroll
// event ever re-renders React. Only the section *name* is published as state,
// because the DOM uses it as readable text (data-stage-section) rather than
// leaving the composition as the only clue about where you are.
function poseOf(config, progress) {
  return {
    section: config.id,
    arrangement: config.arrangement,
    progress,
    camera: config.camera,
    blend: config.transition?.blend ?? 0.5,
    turntable: config.turntable === true
  };
}

export function useBlockStageScroll({ enabled = false } = {}) {
  const poseRef = useRef(poseOf(scrollTimelineConfig.hero, 0));
  const [section, setSection] = useState(scrollTimelineConfig.hero.id);

  useEffect(() => {
    if (!enabled) return undefined;
    const triggers = [];

    for (const key of stageSectionOrder) {
      const config = scrollTimelineConfig[key];
      const element = document.querySelector(config.trigger);
      if (!element) continue;
      // Sections the film does not re-stage (use cases, craft, getting in,
      // questions) hold the previous composition and report their own name.
      const held = config.hold ? scrollTimelineConfig[config.hold] : null;
      const trigger = ScrollTrigger.create({
        trigger: element,
        start: config.start,
        end: config.end,
        scrub: true,
        onUpdate(self) {
          const next = held
            ? { ...poseOf(held, 1), section: config.id }
            : poseOf(config, self.progress);
          poseRef.current = next;
          setSection(current => (current === next.section ? current : next.section));
        }
      });
      triggers.push(trigger);
    }

    const refresh = () => ScrollTrigger.refresh();
    window.addEventListener("resize", refresh);
    window.addEventListener("orientationchange", refresh);

    return () => {
      window.removeEventListener("resize", refresh);
      window.removeEventListener("orientationchange", refresh);
      for (const trigger of triggers) trigger.kill();
    };
  }, [enabled]);

  return { poseRef, section };
}
