'use client';

import { useEffect, useRef } from 'react';

import './GradientText.css';

const VARIANTS = ['linear', 'flow', 'conic'];
const ANGLES = { horizontal: 90, vertical: 180, diagonal: 135 };
const TAU = Math.PI * 2;

const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

/* GradientText no longer paints a gradient. The moving image it builds is an alpha
   MASK, and two flat token colours sit underneath it — so any pixel of the headline
   is either colour A, colour B, or a blend of the two, and a blend of two readable
   colours is still readable. That is what keeps an animated headline inside a design
   system that bans gradient fills, and it is why `colors` now means "the two colours
   the sweep passes between" rather than "the stops of a painted ramp". */
export default function GradientText({
  children,
  colors = ['var(--accent)', 'var(--text)'],
  animationSpeed = 8,
  variant = 'linear',
  angle = 90,
  direction,
  scale = 3,
  yoyo = true,
  /* Named `glow` by the vendored API. It is the sweep layer's opacity — how much of
     the second colour the moving mask is allowed to show — and nothing about it is
     a glow: a glow is emitted light, and this is a flat colour clipped by a mask. */
  glow = 1,
  showBorder = false,
  borderWidth = 1.5,
  pauseOnHover = false,
  followPointer = false,
  className = '',
  style
}) {
  const rootRef = useRef(null);
  const settingsRef = useRef(null);
  const wakeRef = useRef(null);
  const palette = colors.length > 1 ? colors : [colors[0] ?? 'var(--text)', colors[0] ?? 'var(--text)'];

  settingsRef.current = {
    colors: palette,
    speed: Math.max(0.2, animationSpeed),
    variant: VARIANTS.includes(variant) ? variant : 'linear',
    angle: direction ? (ANGLES[direction] ?? angle) : angle,
    scale: clamp(scale, 1, 6),
    yoyo,
    pauseOnHover,
    followPointer
  };

  useEffect(() => {
    wakeRef.current?.();
  });

  useEffect(() => {
    const root = rootRef.current;
    if (!root) return undefined;

    const reduce = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
    const state = { time: 0, inside: false, visible: true, x: 0.5, y: 0.5, px: 0.5, py: 0.5, vx: 0, vy: 0, pull: 0 };
    let raf = 0;
    let last = 0;
    let alive = true;

    const paint = () => {
      const s = settingsRef.current;
      const cycle = state.time / s.speed;
      let image;
      if (s.variant === 'flow') {
        /* Each blob is an opaque core fading to nothing, and the union of their
           alphas is what shows through of the second colour. */
        const blobs = Array.from({ length: s.colors.length }, (_entry, i) => {
          const spin = cycle * TAU;
          const rate = 0.55 + ((i * 0.618) % 1) * 0.5;
          let x = 50 + 44 * Math.sin(spin * rate + i * 2.1);
          let y = 50 + 40 * Math.sin(spin * (rate * 0.83 + 0.21) + i * 1.3);
          if (i === 0) {
            x += (state.px * 100 - x) * state.pull;
            y += (state.py * 100 - y) * state.pull;
          }
          return `radial-gradient(ellipse ${(22 + 12 * s.scale).toFixed(1)}% ${(60 + 30 * s.scale).toFixed(1)}% at ${x.toFixed(2)}% ${y.toFixed(2)}%, black 0%, transparent 100%)`; // guard-allow: mask alpha stops, geometry not paint
        });
        image = `${blobs.join(', ')}, linear-gradient(${s.angle}deg, black 0%, transparent 100%)`; // guard-allow: mask alpha stops, geometry not paint
      } else if (s.variant === 'conic') {
        const sway = s.yoyo ? Math.sin(cycle * Math.PI) * 50 : cycle * 360;
        const cx = 50 + (state.px * 100 - 50) * state.pull;
        const cy = 260 + (state.py * 100 - 260) * state.pull;
        const spokes = Array.from({ length: s.colors.length }, (_entry, i) =>
          `${i % 2 ? 'transparent' : 'black'} ${((i / s.colors.length) * 60 * (3 / s.scale)).toFixed(2)}deg`).join(', ');
        image = `repeating-conic-gradient(from ${(sway - 30).toFixed(2)}deg at ${cx.toFixed(2)}% ${cy.toFixed(2)}%, ${spokes})`; // guard-allow: mask alpha stops, geometry not paint
      } else {
        const period = 100 * s.scale;
        let offset;
        if (s.yoyo) {
          const swing = cycle % 2;
          const t = swing < 1 ? swing : 2 - swing;
          offset = (0.5 - Math.cos(Math.PI * t) / 2) * (period - 100);
        } else {
          offset = (cycle % 1) * period;
        }
        offset += (state.px - 0.5) * period * 0.5 * state.pull;
        /* Black and transparent at the same positions the painted ramp used: the
           band travels, but nothing about it is a colour. */
        const stops = [0, 1].flatMap(i => [`${i ? 'transparent' : 'black'} ${(i * period / 2 - offset).toFixed(2)}%`]);
        image = `repeating-linear-gradient(${s.angle}deg, ${stops.join(', ')})`; // guard-allow: mask alpha stops, geometry not paint
      }
      root.style.setProperty('--gt-sweep', image);
    };

    const tick = now => {
      raf = 0;
      if (!alive) return;
      const s = settingsRef.current;
      const dt = Math.min(0.05, Math.max(0, (now - last) / 1000));
      last = now;
      const paused = reduce || (s.pauseOnHover && state.inside);
      if (!paused) state.time += dt;
      const target = s.followPointer && state.inside ? 1 : 0;
      state.pull += (target - state.pull) * (1 - Math.exp(-dt * 6));
      const stiffness = 160;
      state.vx += ((state.x - state.px) * stiffness - state.vx * 2 * Math.sqrt(stiffness)) * dt;
      state.vy += ((state.y - state.py) * stiffness - state.vy * 2 * Math.sqrt(stiffness)) * dt;
      state.px += state.vx * dt;
      state.py += state.vy * dt;
      paint();
      const settling = Math.abs(state.pull - target) > 0.001 || Math.abs(state.vx) + Math.abs(state.vy) > 0.001;
      if (!state.visible || (paused && !settling)) return;
      raf = requestAnimationFrame(tick);
    };

    const wake = () => {
      if (raf || !alive) return;
      last = performance.now();
      raf = requestAnimationFrame(tick);
    };
    wakeRef.current = () => {
      paint();
      wake();
    };

    const locate = event => {
      const rect = root.getBoundingClientRect();
      state.x = clamp((event.clientX - rect.left) / rect.width, 0, 1);
      state.y = clamp((event.clientY - rect.top) / rect.height, 0, 1);
    };
    const onEnter = event => {
      locate(event);
      if (!state.inside) {
        state.px = state.x;
        state.py = state.y;
      }
      state.inside = true;
      wake();
    };
    const onMove = event => {
      locate(event);
      wake();
    };
    const onLeave = () => {
      state.inside = false;
      wake();
    };

    const observer = new IntersectionObserver(entries => {
      state.visible = entries.some(entry => entry.isIntersecting);
      if (state.visible) wake();
    });
    observer.observe(root);
    root.addEventListener('pointerenter', onEnter);
    root.addEventListener('pointermove', onMove);
    root.addEventListener('pointerleave', onLeave);
    paint();
    wake();

    return () => {
      alive = false;
      cancelAnimationFrame(raf);
      observer.disconnect();
      root.removeEventListener('pointerenter', onEnter);
      root.removeEventListener('pointermove', onMove);
      root.removeEventListener('pointerleave', onLeave);
      wakeRef.current = null;
    };
  }, []);

  /* The list's last colour is what the headline always reads as; the first is the
     colour the sweep passes through. Both are flat, so `background-clip: text` and
     the transparent text fill it needed are gone. */
  const base = palette[palette.length - 1];
  const tint = palette[0];

  return (
    <span
      ref={rootRef}
      className={`gradient-text${showBorder ? ' gradient-text--border' : ''}${className ? ` ${className}` : ''}`}
      style={{
        '--gt-base': base,
        '--gt-tint': tint,
        '--gt-border': `${borderWidth}px`,
        '--gt-strength': clamp(glow, 0, 1),
        ...style
      }}
    >
      <span className="gradient-text__inner">
        <span className="gradient-text__content">{children}</span>
        <span className="gradient-text__sweep" aria-hidden="true">
          {children}
        </span>
      </span>
    </span>
  );
}
