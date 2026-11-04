import React, { useRef } from "react";
import { motion, useMotionValue, useReducedMotion, useSpring } from "motion/react";

// A pull of at most six pixels, and nothing else: the element keeps the tag,
// the label, the handler and the destination it had before. With reduced motion
// the pointer is ignored entirely, so the button is exactly the plain control.

const MAX_PULL = 6;

function clamp(value, limit) {
  return Math.min(limit, Math.max(-limit, value));
}

export default function MagneticButton({ className = "", children, pull = MAX_PULL, ...rest }) {
  const reduce = useReducedMotion();
  const ref = useRef(null);
  const x = useMotionValue(0);
  const y = useMotionValue(0);
  const spring = { stiffness: 380, damping: 30, mass: 0.5 };
  const sx = useSpring(x, spring);
  const sy = useSpring(y, spring);

  const track = event => {
    if (reduce) return;
    const box = ref.current?.getBoundingClientRect();
    if (!box || !box.width || !box.height) return;
    const dx = (event.clientX - (box.left + box.width / 2)) / (box.width / 2);
    const dy = (event.clientY - (box.top + box.height / 2)) / (box.height / 2);
    x.set(clamp(dx * pull, pull));
    y.set(clamp(dy * pull, pull));
  };

  const release = () => {
    x.set(0);
    y.set(0);
  };

  return (
    <motion.button
      ref={ref}
      type="button"
      className={`vr-magnetic ${className}`.trim()}
      style={{ x: sx, y: sy }}
      onPointerMove={track}
      onPointerLeave={release}
      onBlur={release}
      {...rest}
    >
      {children}
    </motion.button>
  );
}
