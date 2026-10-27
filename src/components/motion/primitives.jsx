import React, { useRef } from "react";
import {
  AnimatePresence,
  motion,
  useMotionValue,
  useReducedMotion,
  useSpring,
  useTransform
} from "motion/react";

/* Shared motion vocabulary for the marketing pages.
   One easing curve, one distance, one duration scale — every primitive here
   reads from it so reveals never drift out of sync with each other. */

export const EASE = [0.22, 0.61, 0.36, 1];
export const DISTANCE = 14;
export const DURATION = 0.42;

const ELEMENTS = {
  div: motion.div,
  span: motion.span,
  p: motion.p,
  li: motion.li,
  ol: motion.ol,
  ul: motion.ul,
  section: motion.section,
  figure: motion.figure,
  article: motion.article,
  header: motion.header
};

function proxy(as) {
  return ELEMENTS[as] || motion.div;
}

/* Viewport-triggered entrance for a block of content. Once only — a reveal
   that replays on every scroll is movement without purpose. */
export function Reveal({ as = "div", delay = 0, distance = 20, duration = DURATION, className, children, ...rest }) {
  const Element = proxy(as);
  const reduce = useReducedMotion();

  return (
    <Element
      className={className}
      initial={reduce ? { opacity: 0 } : { opacity: 0, y: distance }}
      whileInView={{ opacity: 1, y: 0 }}
      viewport={{ once: true, amount: 0.15 }}
      transition={reduce ? { duration: 0.15 } : { duration, delay, ease: EASE }}
      {...rest}
    >
      {children}
    </Element>
  );
}

const groupVariants = (stagger, delay) => ({
  hidden: {},
  visible: { transition: { staggerChildren: stagger, delayChildren: delay } }
});

const itemVariants = {
  hidden: { opacity: 0, y: DISTANCE },
  visible: { opacity: 1, y: 0, transition: { duration: DURATION, ease: EASE } }
};

const reducedGroup = { hidden: {}, visible: { transition: { staggerChildren: 0, delayChildren: 0 } } };
const reducedItem = { hidden: { opacity: 0 }, visible: { opacity: 1, transition: { duration: 0.15 } } };

/* Coordinated mount entrance for a set of related elements — the hero column
   runs heading, copy, actions, proof as one sequence instead of four timers.
   trigger="view" defers the sequence until the group scrolls into frame, so a
   grid below the fold still animates where the reader can see it. */
export function StaggerGroup({
  as = "div",
  stagger = 0.07,
  delay = 0.05,
  trigger = "mount",
  amount = 0.15,
  className,
  children,
  ...rest
}) {
  const Element = proxy(as);
  const reduce = useReducedMotion();
  const onView = trigger === "view";

  return (
    <Element
      className={className}
      variants={reduce ? reducedGroup : groupVariants(stagger, delay)}
      initial="hidden"
      {...(onView
        ? { whileInView: "visible", viewport: { once: true, amount } }
        : { animate: "visible" })}
      {...rest}
    >
      {children}
    </Element>
  );
}

export function StaggerItem({ as = "div", className, children, ...rest }) {
  const Element = proxy(as);
  const reduce = useReducedMotion();

  return (
    <Element className={className} variants={reduce ? reducedItem : itemVariants} {...rest}>
      {children}
    </Element>
  );
}

/* One hover/press language for every surface that invites a click.
   Transform only, so nothing reflows. `shine` adds the CSS sweep, which is
   pure presentation and degrades on its own under reduced motion. */
export function HoverSurface({ as = "div", lift = 3, shine = false, className = "", children, ...rest }) {
  const Element = proxy(as);
  const reduce = useReducedMotion();

  return (
    <Element
      className={`hoverable${shine ? " hoverable--shine" : ""} ${className}`.trim()}
      whileHover={reduce ? undefined : { y: -lift }}
      whileTap={reduce ? undefined : { scale: 0.995 }}
      transition={{ duration: 0.18, ease: EASE }}
      {...rest}
    >
      {children}
    </Element>
  );
}

/* Pointer-tracked 3D tilt with a light that follows the cursor.
   The rotation is spring-damped so the card settles instead of snapping, and
   the highlight position is published as motion values for the glare layer. */
function useTilt(max, reduce) {
  const nodeRef = useRef(null);
  const rotateX = useMotionValue(0);
  const rotateY = useMotionValue(0);
  const spring = { stiffness: 240, damping: 24, mass: 0.4 };
  const tiltX = useSpring(rotateX, spring);
  const tiltY = useSpring(rotateY, spring);
  const glareX = useTransform(tiltY, [-max, max], ["22%", "78%"]);
  const glareY = useTransform(tiltX, [-max, max], ["78%", "22%"]);

  return {
    nodeRef,
    style: reduce
      ? undefined
      : {
          rotateX: tiltX,
          rotateY: tiltY,
          transformPerspective: 900,
          transformStyle: "preserve-3d"
        },
    glareStyle: reduce ? undefined : { left: glareX, top: glareY },
    handlers: {
      onPointerMove(event) {
        if (reduce) return;
        const node = nodeRef.current;
        if (!node) return;
        const box = node.getBoundingClientRect();
        const px = (event.clientX - box.left) / Math.max(1, box.width);
        const py = (event.clientY - box.top) / Math.max(1, box.height);
        rotateY.set((px - 0.5) * max * 2);
        rotateX.set((0.5 - py) * max * 2);
        node.style.setProperty("--vr-tilt-x", `${(px * 100).toFixed(2)}%`);
        node.style.setProperty("--vr-tilt-y", `${(py * 100).toFixed(2)}%`);
      },
      onPointerLeave() {
        rotateX.set(0);
        rotateY.set(0);
      }
    }
  };
}

function Glare({ style }) {
  return <span className="vr-tilt__glare" aria-hidden="true" style={style} />;
}

export function TiltCard({ as = "div", max = 5.5, lift = 4, className = "", children, ...rest }) {
  const Element = proxy(as);
  const reduce = useReducedMotion();
  const tilt = useTilt(max, reduce);

  return (
    <Element
      ref={tilt.nodeRef}
      className={`vr-tilt${className ? ` ${className}` : ""}`}
      style={tilt.style}
      whileHover={reduce ? undefined : { y: -lift }}
      transition={{ duration: 0.2, ease: EASE }}
      {...tilt.handlers}
      {...rest}
    >
      <Glare style={tilt.glareStyle} />
      {children}
    </Element>
  );
}

/* Same surface, but driven by the parent StaggerGroup's variants so a grid
   cell can enter on scroll and still tilt under the pointer without two
   nested transform layers fighting over the same element. */
export function TiltItem({ as = "div", max = 5, className = "", children, ...rest }) {
  const Element = proxy(as);
  const reduce = useReducedMotion();
  const tilt = useTilt(max, reduce);

  return (
    <Element
      ref={tilt.nodeRef}
      className={`vr-tilt${className ? ` ${className}` : ""}`}
      variants={reduce ? reducedItem : itemVariants}
      style={tilt.style}
      {...tilt.handlers}
      {...rest}
    >
      <Glare style={tilt.glareStyle} />
      {children}
    </Element>
  );
}

export { motion, AnimatePresence, useReducedMotion };
