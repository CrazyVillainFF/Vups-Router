import { gsap } from "gsap";
import { useGSAP } from "@gsap/react";
import { ScrollTrigger } from "gsap/ScrollTrigger";
import { SplitText } from "gsap/SplitText";
import { ScrollToPlugin } from "gsap/ScrollToPlugin";
import { phaseId } from "../dimension/stagePose.js";
import { D, EASE, EASE_DRAW, EASE_SOFT, STAGGER } from "./motionTokens.js";

/* The scroll layer for the home page.

   GSAP ScrollTrigger owns the narrative: one scrubbed trigger drives the camera
   of the 3D stage, the rest are entrance triggers on the sections a reader
   actually reaches. `useGSAP` gives every one of them a scope and reverts all of
   them — the SplitText masks included — when the page unmounts.

   Two rules shape everything below. Nothing is hidden by CSS: the initial states
   are applied by `gsap.set` inside this context, so a reader whose scripts never
   run still sees a finished page. And the spectacle is spent on the hero and the
   network; the sections in between get one motion each. */

gsap.registerPlugin(ScrollTrigger, SplitText, ScrollToPlugin, useGSAP);

export function useHomeMotion({ scopeRef, poseRef, animate = true }) {
  useGSAP(
    () => {
      const root = scopeRef.current;
      if (!root) return;
      /* Scoped selectors: the page is one of several routes and a class name
         such as [data-rise] must never reach outside this composition. */
      const qa = selector => Array.from(root.querySelectorAll(selector));
      const q = selector => root.querySelector(selector);

      if (!animate) return;

      gsap.set(qa("[data-rise]"), { autoAlpha: 0, y: 26 });
      for (const group of qa("[data-rise-group]")) {
        gsap.set(group.children, { autoAlpha: 0, y: 22 });
      }
      gsap.set(qa("[data-rule]"), { scaleX: 0, transformOrigin: "left center" });

      /* --- hero -------------------------------------------------------- */
      const title = q("[data-hero-title]");
      if (title) {
        SplitText.create(title, {
          type: "lines",
          linesClass: "vd-line",
          mask: "lines",
          autoSplit: true,
          onSplit(self) {
            return gsap.fromTo(
              self.lines,
              { yPercent: 108, autoAlpha: 0 },
              {
                yPercent: 0,
                autoAlpha: 1,
                duration: D.stage,
                ease: EASE,
                stagger: STAGGER.line
              }
            );
          }
        });
      }

      gsap
        .timeline({ defaults: { ease: EASE, duration: D.stage } })
        .fromTo(
          qa("[data-hero-eyebrow]"),
          { autoAlpha: 0, x: -14 },
          { autoAlpha: 1, x: 0, duration: D.section }
        )
        .fromTo(
          qa("[data-hero-lead]"),
          { autoAlpha: 0, y: 20 },
          { autoAlpha: 1, y: 0 },
          "<-=0.42"
        )
        .fromTo(
          qa("[data-hero-actions] > *"),
          { autoAlpha: 0, y: 16 },
          { autoAlpha: 1, y: 0, stagger: STAGGER.card, duration: D.section },
          "<-=0.24"
        )
        .fromTo(
          qa("[data-hero-facts] > *"),
          { autoAlpha: 0 },
          { autoAlpha: 1, stagger: STAGGER.card, duration: D.section },
          "<"
        );

      /* --- the dimensional act ----------------------------------------- */
      const act = q("[data-stage-act]");
      if (act && poseRef) {
        ScrollTrigger.create({
          trigger: act,
          start: "top top",
          end: "bottom bottom",
          scrub: 0.7,
          invalidateOnRefresh: true,
          onUpdate: self => {
            poseRef.current.progress = self.progress;
            /* The HUD is a DOM readout of a canvas the DOM cannot inspect, so it
               reports the pose the scroll is asking for — written as an attribute
               instead of React state, because this runs on every scroll frame. */
            const phase = phaseId(self.progress);
            if (act.dataset.phase !== phase) act.dataset.phase = phase;
          }
        });
        act.dataset.phase = phaseId(poseRef.current.progress);
      }

      /* One tween for the whole document: the rail's progress bar. Scrubbing a
         scaleY on the bar is cheaper than a React state update per frame and
         keeps the number honest while the page is still loading. */
      const progress = q("[data-progress]");
      if (progress) {
        gsap.fromTo(progress,
          { scaleY: 0, transformOrigin: "top center" },
          {
            scaleY: 1,
            ease: "none",
            scrollTrigger: {
              trigger: document.documentElement,
              start: "top top",
              end: "bottom bottom",
              scrub: 0.3
            }
          });
      }

      /* --- sections ----------------------------------------------------- */
      for (const group of qa("[data-rise-group]")) {
        gsap.to(group.children, {
          autoAlpha: 1,
          y: 0,
          duration: D.section,
          ease: EASE_SOFT,
          stagger: { each: STAGGER.card, from: "start" },
          scrollTrigger: { trigger: group, start: "top 74%", once: true }
        });
      }

      /* A [data-rise] that is not inside a group animates on its own; the ones
         that are get handled above, so they never receive two tweens. */
      for (const item of qa("[data-rise]")) {
        if (item.closest("[data-rise-group]")) continue;
        gsap.to(item, {
          autoAlpha: 1,
          y: 0,
          duration: D.section,
          ease: EASE_SOFT,
          scrollTrigger: { trigger: item, start: "top 82%", once: true }
        });
      }

      for (const rule of qa("[data-rule]")) {
        gsap.to(rule, {
          scaleX: 1,
          duration: D.scene * 0.42,
          ease: EASE_DRAW,
          scrollTrigger: { trigger: rule, start: "top 88%", once: true }
        });
      }

      /* The one scrub in the editorial half: the process line grows because the
         three steps sit along it. */
      const process = q("[data-process]");
      if (process) {
        const rail = process.querySelector("[data-process-rail]");
        if (rail) {
          gsap.fromTo(
            rail,
            { scaleY: 0, transformOrigin: "top center" },
            {
              scaleY: 1,
              ease: "none",
              scrollTrigger: {
                trigger: process,
                start: "top 72%",
                end: "bottom 62%",
                scrub: 0.6
              }
            }
          );
        }
      }

      /* A hair of drift on the two large pull-quotes — enough that the page
         feels physical while scrolling, not enough to read as an effect. */
      for (const quote of qa("[data-drift]")) {
        gsap.fromTo(
          quote,
          { y: 16 },
          {
            y: -16,
            ease: "none",
            scrollTrigger: { trigger: quote, start: "top bottom", end: "bottom top", scrub: true }
          }
        );
      }
    },
    { scope: scopeRef, dependencies: [animate] }
  );
}

/** Rail navigation: a click and a keyboard activation land on the same offset,
    and the travel is interruptible because it is a tween on the window. */
export function scrollHomeSection(id, { offset = 84, reduceMotion = false } = {}) {
  const target = document.getElementById(id);
  if (!target) return false;
  if (reduceMotion) {
    window.scrollTo(0, Math.max(0, target.getBoundingClientRect().top + window.scrollY - offset));
    return true;
  }
  gsap.to(window, { duration: 0.9, ease: EASE, scrollTo: { y: target, offsetY: offset } });
  return true;
}
