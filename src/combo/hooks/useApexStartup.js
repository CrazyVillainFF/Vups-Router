import { useEffect, useRef, useState } from "react";
import { gsap } from "gsap";
import { STARTUP_DURATION } from "../comboScene.js";

// One coordinated power-on for the Apex page: a single monotonic driver feeds the
// WebGL machine (which reads it inside its own frame loop, never through React)
// while a GSAP timeline reveals the DOM shell around it. The order is the order
// a real machine would boot in - room light, core assembly, ignition, provider
// discovery, connection, activation - and the settings panel is the last thing to
// fade up so nothing essential is ever hidden behind the sequence.
//
// A module flag, not component state, decides whether the sequence has played:
// React 19 StrictMode mounts every effect twice in development, and an
// ordinary rerender must never replay a boot animation either.
let sequencePlayed = false;

const REVEAL_SELECTORS = ".combo-head, .combo-stage__core, .combo-panel, .combo-stage__note";

function prefersReducedMotion() {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return false;
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

export function resetApexStartup() {
  sequencePlayed = false;
}

export default function useApexStartup(rootRef, options = {}) {
  const skip = options.enabled === false || prefersReducedMotion();
  // A mount that arrives after the sequence already played must not start cold:
  // nothing would run the driver forward, and the machine would never assemble.
  const settledRef = useRef(skip || sequencePlayed);
  const driverRef = useRef(settledRef.current ? 1 : 0);
  const [running, setRunning] = useState(false);

  useEffect(() => {
    const root = rootRef.current;
    if (skip) {
      driverRef.current = 1;
      return undefined;
    }
    if (settledRef.current || !root || !options.ready) return undefined;
    settledRef.current = true;
    sequencePlayed = true;

    const driver = { value: 0 };
    const targets = [...root.querySelectorAll(REVEAL_SELECTORS)];
    let completed = false;
    setRunning(true);
    root.dataset.apexStartup = "running";

    const context = gsap.context(() => {
      const timeline = gsap.timeline({
        defaults: { ease: "power2.out", overwrite: "auto" },
        onComplete: () => {
          completed = true;
          driver.value = 1;
          driverRef.current = 1;
          setRunning(false);
          delete root.dataset.apexStartup;
          // The finished values are the CSS defaults, so the shell is handed back
          // with no inline residue for later rules to fight.
          gsap.set(targets, { clearProps: "opacity,visibility,transform" });
        }
      });
      timeline
        // The single driver the 3D layer maps its phase windows onto.
        .to(driver, {
          value: 1,
          duration: STARTUP_DURATION,
          ease: "power1.inOut",
          onUpdate: () => {
            driverRef.current = driver.value;
          }
        }, 0)
        .fromTo(
          ".combo-head",
          { autoAlpha: 0, y: -12 },
          { autoAlpha: 1, y: 0, duration: 0.55 },
          0
        )
        .fromTo(
          ".combo-stage__core",
          { autoAlpha: 0, scale: 0.94 },
          { autoAlpha: 1, scale: 1, duration: 0.62 },
          0.14
        )
        // Opacity only, never autoAlpha: the library stays focusable and
        // clickable while it fades in, so a boot animation cannot lock a
        // control the user needs.
        .fromTo(
          ".combo-panel",
          { opacity: 0, y: 16 },
          { opacity: 1, y: 0, duration: 0.5 },
          STARTUP_DURATION - 0.62
        )
        .fromTo(
          ".combo-stage__note",
          { opacity: 0 },
          { opacity: 1, duration: 0.4 },
          STARTUP_DURATION - 0.3
        );
    }, root);

    return () => {
      context.kill();
      // Never revert(): that would hand the shell back its pre-animation hidden
      // values. Clearing the props leaves every layer where the CSS puts it.
      gsap.set(targets, { clearProps: "opacity,visibility,transform" });
      setRunning(false);
      delete root.dataset.apexStartup;
      if (completed) {
        driverRef.current = 1;
        return;
      }
      // An interrupted run is only spent if it had already reached a frame.
      // Being torn down before the first tick is React 19's StrictMode double
      // mount, so the sequence is handed back for the effect to replay; anything
      // later - leaving the page mid-boot - stays finished, not rewound.
      if (driver.value === 0) {
        sequencePlayed = false;
        settledRef.current = false;
        driverRef.current = 0;
      } else {
        driverRef.current = 1;
      }
    };
  }, [options.ready, skip, rootRef]);

  return { driverRef, running };
}
