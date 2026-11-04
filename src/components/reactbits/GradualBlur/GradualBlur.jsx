'use client';

import { useEffect, useLayoutEffect, useMemo, useRef } from 'react';

import './GradualBlur.css';

const useIsomorphicLayoutEffect = typeof window !== 'undefined' ? useLayoutEffect : useEffect;

const CURVES = {
  linear: t => t,
  bezier: t => t * t * (3 - 2 * t),
  'ease-in': t => t * t,
  'ease-out': t => 1 - (1 - t) * (1 - t),
  'ease-in-out': t => (t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2)
};

const DIRECTIONS = { top: 'to top', bottom: 'to bottom', left: 'to left', right: 'to right' };

const clamp01 = value => Math.min(Math.max(value, 0), 1);

const toLength = value => (typeof value === 'number' ? `${value}px` : value);

const toTime = value => (typeof value === 'number' ? `${value}s` : value);

const findScroller = (container, root, target, vertical) => {
  if (container) {
    if (typeof container === 'string') return document.querySelector(container);
    return 'current' in container ? container.current : container;
  }
  if (target === 'page') return window;
  const parent = root.parentElement;
  if (!parent) return null;
  const scrolls = node => {
    const style = getComputedStyle(node);
    return /(auto|scroll|overlay)/.test(vertical ? style.overflowY : style.overflowX);
  };
  const sibling = Array.from(parent.children).find(child => child !== root && scrolls(child));
  return sibling || (scrolls(parent) ? parent : null);
};

/* `strength` and `layers` came from a stacked-backdrop-blur implementation.
   backdrop-filter is banned, so the fade is built from stacked translucent slabs
   of one token colour instead: `strength` bends the ramp, `layers` is its
   resolution, and the old `saturation` (accepted, unread) has nothing left to act on. */
const GradualBlur = ({
  position = 'bottom',
  target = 'parent',
  height = '6rem',
  width,
  strength = 2,
  layers = 8,
  curve = 'linear',
  exponential = true,
  opacity = 1,
  tint = 'transparent',
  autoHide = false,
  container,
  hoverIntensity = 1,
  duration = 0.3,
  easing = 'ease-out',
  zIndex = 1000,
  className = '',
  style
}) => {
  const rootRef = useRef(null);
  const edge = DIRECTIONS[position] ? position : 'bottom';
  const vertical = edge === 'top' || edge === 'bottom';

  const stack = useMemo(() => {
    const count = Math.min(Math.max(Math.round(layers) || 1, 1), 16);
    const shape = CURVES[curve] || CURVES.linear;
    const peak = clamp01(opacity);
    const bend = exponential ? 4 * clamp01(Math.max(strength, 0) / 3) : 0;
    const level = u => {
      const t = shape(clamp01(u));
      return bend ? (Math.pow(2, bend * t) - 1) / (Math.pow(2, bend) - 1) : t;
    };
    const fade = `${toTime(duration)} ${easing}`;
    const direction = DIRECTIONS[edge];
    const veil = tint && tint !== 'transparent' ? tint : 'var(--bg)';

    /* A slab covers everything outward from its own band, so the composite is
       1 - product(1 - weight). Solving each weight against that identity makes
       the total alpha land on `level` at every band edge and interpolate inside it. */
    const steps = [];
    let remaining = 1;
    for (let i = 0; i < count; i++) {
      const left = Math.max(1 - peak * level((i + 1) / count), 1e-6);
      const weight = clamp01(1 - left / remaining);
      remaining = left;
      const mask = `linear-gradient(${direction}, transparent ${((i / count) * 100).toFixed(2)}%, black ${(((i + 1) / count) * 100).toFixed(2)}%)`; // guard-allow: mask alpha stops, geometry not paint
      steps.push({
        position: 'absolute',
        inset: 0,
        borderRadius: 'inherit',
        background: veil,
        maskImage: mask,
        WebkitMaskImage: mask,
        opacity: weight ? `calc(${weight.toFixed(4)} * var(--gradual-blur-reveal, 1) * var(--gradual-blur-hover, 1))` : 0,
        transition: `opacity ${fade}`
      });
    }
    return { steps };
  }, [layers, curve, strength, exponential, duration, easing, edge, opacity, tint]);

  useIsomorphicLayoutEffect(() => {
    const root = rootRef.current;
    if (!root) return undefined;
    if (!autoHide) {
      root.style.removeProperty('--gradual-blur-reveal');
      return undefined;
    }
    const scroller = findScroller(container, root, target, vertical);
    if (!scroller) return undefined;
    const element = scroller instanceof Element ? scroller : null;
    const start = edge === 'top' || edge === 'left';

    const update = () => {
      const page = document.documentElement;
      const offset = element
        ? vertical
          ? element.scrollTop
          : element.scrollLeft
        : vertical
          ? window.scrollY
          : window.scrollX;
      const limit = element
        ? vertical
          ? element.scrollHeight - element.clientHeight
          : element.scrollWidth - element.clientWidth
        : vertical
          ? page.scrollHeight - window.innerHeight
          : page.scrollWidth - window.innerWidth;
      const box = root.getBoundingClientRect();
      const reach = Math.max(vertical ? box.height : box.width, 1);
      const room = start ? offset : limit - offset;
      root.style.setProperty('--gradual-blur-reveal', clamp01(room / reach).toFixed(3));
    };

    update();
    const source = element ?? window;
    source.addEventListener('scroll', update, { passive: true });
    window.addEventListener('resize', update);
    const observer = element && typeof ResizeObserver !== 'undefined' ? new ResizeObserver(update) : null;
    if (observer && element) {
      observer.observe(element);
      if (element.firstElementChild) observer.observe(element.firstElementChild);
    }
    return () => {
      source.removeEventListener('scroll', update);
      window.removeEventListener('resize', update);
      observer?.disconnect();
    };
  }, [autoHide, container, target, edge, vertical]);

  useEffect(() => {
    const root = rootRef.current;
    if (!root || hoverIntensity === 1) return undefined;
    let frame = 0;
    let inside = false;
    let point = null;

    const check = () => {
      frame = 0;
      if (!point) return;
      const box = root.getBoundingClientRect();
      const now = point.x >= box.left && point.x <= box.right && point.y >= box.top && point.y <= box.bottom;
      if (now === inside) return;
      inside = now;
      root.style.setProperty('--gradual-blur-hover', inside ? String(Math.max(hoverIntensity, 0)) : '1');
    };

    const onMove = event => {
      point = { x: event.clientX, y: event.clientY };
      if (!frame) frame = requestAnimationFrame(check);
    };

    const onLeave = () => {
      point = null;
      inside = false;
      root.style.setProperty('--gradual-blur-hover', '1');
    };

    window.addEventListener('pointermove', onMove, { passive: true });
    document.documentElement.addEventListener('pointerleave', onLeave);
    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener('pointermove', onMove);
      document.documentElement.removeEventListener('pointerleave', onLeave);
      root.style.removeProperty('--gradual-blur-hover');
    };
  }, [hoverIntensity]);

  const depth = toLength(vertical ? height : (width ?? height));
  const span = vertical && width != null ? toLength(width) : null;

  const rounded = target !== 'page' && !span;
  const corner = (a, b) => (rounded && (edge === a || edge === b) ? 'inherit' : undefined);

  const rootStyle = {
    position: target === 'page' ? 'fixed' : 'absolute',
    zIndex,
    borderTopLeftRadius: corner('top', 'left'),
    borderTopRightRadius: corner('top', 'right'),
    borderBottomLeftRadius: corner('bottom', 'left'),
    borderBottomRightRadius: corner('bottom', 'right'),
    top: edge === 'bottom' ? undefined : 0,
    bottom: edge === 'top' ? undefined : 0,
    left: edge === 'right' ? undefined : 0,
    right: edge === 'left' ? undefined : 0,
    height: vertical ? depth : undefined,
    width: vertical ? (span ?? undefined) : depth,
    marginInline: span ? 'auto' : undefined,
    ...style
  };

  return (
    <div ref={rootRef} className={`gradual-blur ${className}`.trim()} style={rootStyle} aria-hidden="true">
      {stack.steps.map((layer, index) => (
        <div key={index} style={layer} />
      ))}
    </div>
  );
};

export default GradualBlur;
