import { Fragment, isValidElement, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { animate, useMotionValue, useMotionValueEvent, useReducedMotion } from 'motion/react';
import { HugeiconsIcon } from '@hugeicons/react';
import {
  ArrowDown01Icon,
  Attachment01Icon,
  Cancel01Icon,
  Delete02Icon,
  File02Icon,
  HelpCircleIcon,
  Key01Icon,
  Mic01Icon,
  SparklesIcon,
  Tick02Icon
} from '@hugeicons/core-free-icons';
import './PromptBar.css';

const ARROW_UP = [12, 4.5, 18.5, 11, 14.25, 11, 14.25, 19.5, 9.75, 19.5, 9.75, 11, 5.5, 11];
const SQUARE = [12, 6, 18, 6, 18, 12, 18, 18, 6, 18, 6, 12, 6, 6];
const EASE_IN_OUT = [0.77, 0, 0.175, 1];
const LINE = 22;
const EDGE = 11;

const DEFAULT_MODELS = [];
const DEFAULT_EFFORTS = ['Precise', 'Balanced', 'Creative'];

const mix = (a, b, t) => a + (b - a) * t;
const pathAt = (a, b, t) => {
  let d = '';
  for (let i = 0; i < a.length; i += 2) {
    d += `${i ? 'L' : 'M'}${mix(a[i], b[i], t).toFixed(2)} ${mix(a[i + 1], b[i + 1], t).toFixed(2)}`;
  }
  return `${d}Z`;
};

const parseToken = draft => {
  const m = /(^|\s)([@/])([\w-]*)$/.exec(draft);
  if (!m) return null;
  return { kind: m[2] === '@' ? 'at' : 'slash', query: m[3].toLowerCase(), start: m.index + m[1].length };
};

const renderIcon = (icon, size) =>
  isValidElement(icon) ? icon : <HugeiconsIcon icon={icon} size={size} strokeWidth={1.8} />;

function SendGlyph({ busy, morphDuration, squash, tilt }) {
  const reduce = useReducedMotion();
  const svgRef = useRef(null);
  const pathRef = useRef(null);
  const dir = useRef(busy ? 1 : -1);
  const t = useMotionValue(busy ? 1 : 0);

  useEffect(() => {
    const target = busy ? 1 : 0;
    dir.current = busy ? 1 : -1;
    if (t.get() === target) return undefined;
    const controls = animate(
      t,
      target,
      reduce ? { duration: 0 } : { duration: morphDuration / 1000, ease: EASE_IN_OUT }
    );
    return () => controls.stop();
  }, [busy, morphDuration, reduce, t]);

  useMotionValueEvent(t, 'change', v => {
    pathRef.current?.setAttribute('d', pathAt(ARROW_UP, SQUARE, v));
    const goo = reduce ? 0 : Math.sin(v * Math.PI);
    const sx = 1 - squash * goo;
    if (svgRef.current) {
      svgRef.current.style.transform = goo ? `rotate(${dir.current * tilt * goo}deg) scale(${sx}, ${1 / sx})` : '';
    }
  });

  return (
    <svg
      ref={svgRef}
      className="prompt-bar__glyph"
      viewBox="0 0 24 24"
      aria-hidden="true"
      fill="currentColor"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinejoin="round"
    >
      <path ref={pathRef} d={pathAt(ARROW_UP, SQUARE, t.get())} />
    </svg>
  );
}

export default function PromptBar({
  placeholder = 'Ask anything',
  sources = [],
  commands = [],
  models = DEFAULT_MODELS,
  defaultModel = '',
  onModelChange,
  onDeleteModel,
  onAddKey,
  openModelSignal = 0,
  efforts = DEFAULT_EFFORTS,
  defaultEffort = '',
  onEffortChange,
  busy = false,
  generating = false,
  onSend,
  beforeSend,
  onStop,
  onGenerateImage,
  onAttach,
  onDictate,
  background = '#111c2e',
  color = '#e9eef7',
  menuBackground = '#16233a',
  sparkColor = '#6c9bff',
  sparkBoost = 1,
  width = 400,
  radius = 16,
  maxRows = 5,
  morphDuration = 240,
  squash = 0.12,
  tilt = 8,
  pressScale = 0.96,
  className = ''
}) {
  const reduce = useReducedMotion();
  const rootRef = useRef(null);
  const inputRef = useRef(null);
  const fileInputRef = useRef(null);
  const glowRef = useRef(null);
  const sparkRef = useRef(null);
  const typing = useRef({ energy: 0, strokes: 0 });
  const boost = useRef(sparkBoost);
  boost.current = sparkBoost;
  const rowRefs = useRef([]);
  const lastOpen = useRef(null);
  const dictation = useRef(0);
  const latest = useRef({});
  latest.current = { onSend, beforeSend, onStop, onGenerateImage, onAttach, onDictate, onEffortChange, onModelChange, onDeleteModel, onAddKey };

  const [draft, setDraft] = useState('');
  const [attachments, setAttachments] = useState([]);
  const [modelKey, setModelKey] = useState(defaultModel);
  const [plusOpen, setPlusOpen] = useState(false);
  const [modelOpen, setModelOpen] = useState(false);
  const [effortOpen, setEffortOpen] = useState(false);
  const [effortIndex, setEffortIndex] = useState(() => {
    const i = efforts.indexOf(defaultEffort);
    return i >= 0 ? i : Math.max(0, Math.floor((efforts.length - 1) / 2));
  });
  const [dismissed, setDismissed] = useState(false);
  const [active, setActive] = useState(0);
  const [modelQuery, setModelQuery] = useState('');
  const [listening, setListening] = useState(false);
  const [pressed, setPressed] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [modelMenuMaxHeight, setModelMenuMaxHeight] = useState(360);

  const model = models.find(m => m.key === modelKey) ?? models[0];
  const lastDefault = useRef(null);
  useEffect(() => {
    if (defaultModel === lastDefault.current) return;
    if (models.some(m => m.key === defaultModel)) {
      setModelKey(defaultModel);
      lastDefault.current = defaultModel;
    }
  }, [defaultModel, models]);
  const lastOpenSignal = useRef(0);
  useEffect(() => {
    if (!openModelSignal || openModelSignal === lastOpenSignal.current) return;
    lastOpenSignal.current = openModelSignal;
    setPlusOpen(false);
    setEffortOpen(false);
    setDismissed(true);
    setModelQuery('');
    setModelOpen(true);
  }, [openModelSignal]);
  const hasTokenMenus = sources.length > 0 || commands.length > 0;
  const token = dismissed || !hasTokenMenus ? null : parseToken(draft);
  const open = plusOpen ? 'at' : (token?.kind ?? (modelOpen ? 'model' : effortOpen ? 'effort' : null));

  useLayoutEffect(() => {
    if (open !== 'model' || !rootRef.current) return undefined;
    const update = () => {
      const top = rootRef.current?.getBoundingClientRect().top ?? 0;
      setModelMenuMaxHeight(Math.max(120, Math.min(360, Math.floor(top - 20))));
    };
    update();
    window.addEventListener('resize', update);
    window.visualViewport?.addEventListener('resize', update);
    return () => {
      window.removeEventListener('resize', update);
      window.visualViewport?.removeEventListener('resize', update);
    };
  }, [open]);

  const query = plusOpen ? '' : (token?.query ?? '');
  const list = useMemo(() => {
    if (open === 'at') return sources.filter(s => s.name.toLowerCase().includes(query));
    if (open === 'slash') return commands.filter(c => c.name.replace(/^\//, '').toLowerCase().startsWith(query));
    if (open === 'model') {
      const needle = modelQuery.trim().toLowerCase();
      if (!needle) return models;
      return models.filter(row =>
        [row.name, row.model, row.provider, row.tag, row.meta, ...(row.capabilityLabels || [])]
          .filter(Boolean)
          .join(' ')
          .toLowerCase()
          .includes(needle)
      );
    }
    return [];
  }, [open, query, sources, commands, models, modelQuery]);
  const cursor = Math.min(active, Math.max(0, list.length - 1));
  const canSend = draft.trim().length > 0 || attachments.length > 0;
  const canGenerate = draft.trim().length > 0 && !busy && !generating;
  const armed = busy || canSend;
  const level = efforts[effortIndex] ?? '';
  const maxed = efforts.length > 1 && effortIndex === efforts.length - 1;

  const focusInput = () => inputRef.current?.focus({ preventScroll: true });

  const collectFiles = useCallback(fileList => {
    const files = [...(fileList || [])].filter(
      file => file && typeof file.type === 'string' && file.type.startsWith('image/')
    );
    if (files.length === 0) return;
    Promise.resolve(latest.current.onAttach?.(files)).then(items => {
      if (!items) return;
      setAttachments(current => [...current, ...(Array.isArray(items) ? items : [items])]);
    }).catch(() => {});
  }, []);

  const closeMenus = useCallback(() => {
    setPlusOpen(false);
    setModelOpen(false);
    setEffortOpen(false);
  }, []);

  useLayoutEffect(() => {
    const glow = glowRef.current;
    if (!glow || !open) return;
    const row = rowRefs.current[cursor];
    if (!row) {
      glow.style.opacity = '0';
      return;
    }
    const fresh = lastOpen.current !== open;
    lastOpen.current = open;
    if (fresh) glow.style.transition = 'none';
    glow.style.top = `${row.offsetTop}px`;
    glow.style.height = `${row.offsetHeight}px`;
    glow.style.opacity = '1';
    if (fresh) {
      void glow.offsetHeight;
      glow.style.transition = '';
    }
  }, [open, cursor, list]);
  useEffect(() => {
    if (!open) lastOpen.current = null;
    if (open !== 'model') setModelQuery('');
  }, [open]);

  useEffect(() => {
    if (!plusOpen && !modelOpen && !effortOpen) return undefined;
    const onDown = e => {
      if (!rootRef.current?.contains(e.target)) closeMenus();
    };
    document.addEventListener('pointerdown', onDown);
    return () => document.removeEventListener('pointerdown', onDown);
  }, [plusOpen, modelOpen, effortOpen, closeMenus]);

  useLayoutEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    el.style.height = '0px';
    const max = LINE * maxRows;
    el.style.height = `${Math.min(el.scrollHeight, max)}px`;
    el.style.overflowY = el.scrollHeight > max ? 'auto' : 'hidden';
  }, [draft, maxRows]);

  useEffect(
    () => () => {
      dictation.current += 1;
    },
    []
  );

  useEffect(() => {
    const canvas = sparkRef.current;
    if (!maxed || reduce || !canvas) return undefined;
    const ctx = canvas.getContext('2d');
    if (!ctx) return undefined;
    typing.current.strokes = 0;
    let raf = 0;
    let last = performance.now();
    let w = 0;
    let h = 0;
    let due = 0;
    let speed = 1;
    let pulse = 0;
    const parts = [];
    const resize = () => {
      const rect = canvas.getBoundingClientRect();
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      w = rect.width;
      h = rect.height;
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(h * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    };
    const spawn = burst => {
      parts.push({
        x: Math.random() * w,
        y: burst ? h * (0.2 + Math.random() * 0.8) : h + 3,
        r: 0.9 + Math.random() * 1.1,
        vy: -(7 + Math.random() * 9),
        sway: (Math.random() - 0.5) * 10,
        phase: Math.random() * Math.PI * 2,
        life: burst ? Math.random() * 1.2 : 0,
        span: 2.4 + Math.random() * 2.4
      });
    };
    const tick = now => {
      const dt = Math.min(0.05, (now - last) / 1000);
      last = now;
      const typed = typing.current;
      const gain = boost.current;
      typed.energy *= Math.exp(-dt / 0.8);
      pulse *= Math.exp(-dt / 0.16);
      if (typed.strokes > 0) {
        typed.strokes = 0;
        if (gain > 0) pulse = 1;
      }
      const energy = typed.energy * gain;
      speed += (1 + energy * 6 - speed) * (1 - Math.exp(-dt / 0.15));
      due += dt;
      while (due > 0.14) {
        due -= 0.14;
        if (parts.length < 30) spawn(false);
      }
      ctx.clearRect(0, 0, w, h);
      ctx.fillStyle = sparkColor;
      ctx.shadowColor = sparkColor;
      ctx.shadowBlur = 6 + energy * 10 + pulse * 6;
      for (let i = parts.length - 1; i >= 0; i -= 1) {
        const p = parts[i];
        p.life += dt;
        if (p.life > p.span) {
          parts.splice(i, 1);
          continue;
        }
        const k = p.life / p.span;
        const twinkle = 0.7 + 0.3 * Math.sin((now / 160) * (1 + energy) + p.phase);
        p.y += p.vy * dt * speed;
        if (p.y < -4) {
          p.y = h + 3;
          p.x = Math.random() * w;
        }
        const edge = Math.min(1, Math.max(0, p.y / 14), Math.max(0, (h - p.y) / 14));
        ctx.globalAlpha = Math.min(1, Math.sin(k * Math.PI) * (0.9 + energy * 0.25) * twinkle) * edge;
        ctx.beginPath();
        ctx.arc(
          p.x + Math.sin((now / 900) * (1 + energy * 0.8) + p.phase) * p.sway,
          p.y,
          p.r * twinkle * (1 + energy * 0.35),
          0,
          Math.PI * 2
        );
        ctx.fill();
      }
      raf = requestAnimationFrame(tick);
    };
    resize();
    for (let i = 0; i < 26; i += 1) spawn(true);
    const ro = new ResizeObserver(resize);
    ro.observe(canvas);
    raf = requestAnimationFrame(tick);
    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
      ctx.clearRect(0, 0, w, h);
    };
  }, [maxed, reduce, sparkColor]);

  const setEffort = i => {
    const next = Math.max(0, Math.min(efforts.length - 1, i));
    if (next === effortIndex) return;
    setEffortIndex(next);
    latest.current.onEffortChange?.(efforts[next]);
  };
  const effortFromPointer = e => {
    const rect = e.currentTarget.getBoundingClientRect();
    const k = (e.clientX - rect.left - EDGE) / Math.max(1, rect.width - 2 * EDGE);
    setEffort(Math.round(k * (efforts.length - 1)));
  };
  const onEffortKey = e => {
    const step =
      e.key === 'ArrowRight' || e.key === 'ArrowUp' ? 1 : e.key === 'ArrowLeft' || e.key === 'ArrowDown' ? -1 : 0;
    if (step) {
      e.preventDefault();
      setEffort(effortIndex + step);
    } else if (e.key === 'Home') {
      e.preventDefault();
      setEffort(0);
    } else if (e.key === 'End') {
      e.preventDefault();
      setEffort(efforts.length - 1);
    } else if (e.key === 'Escape') {
      setEffortOpen(false);
      focusInput();
    }
  };
  const stepAt = i => `calc(${EDGE}px + (100% - ${EDGE * 2}px) * ${i / Math.max(1, efforts.length - 1)})`;
  const fillAt = i => (i === efforts.length - 1 ? '100%' : `calc(${stepAt(i)} + 7px)`);

  const pick = row => {
    if (!row || row.disabled) return;
    if (open === 'model') {
      setModelKey(row.key);
      latest.current.onModelChange?.(row);
      setModelOpen(false);
      focusInput();
      return;
    }
    const head = token ? draft.slice(0, token.start) : draft;
    if (row.attach) {
      setDraft(head);
      fileInputRef.current?.click();
    } else if (open === 'at') {
      setDraft(`${head}@${row.name} `);
    } else {
      setDraft(`${head}${row.name} `);
    }
    setPlusOpen(false);
    setDismissed(false);
    focusInput();
  };

  const send = () => {
    if (!canSend || busy) return;
    if (latest.current.beforeSend?.(draft.trim(), attachments) === false) return;
    latest.current.onSend?.(draft.trim(), { attachments, model, effort: level });
    setDraft('');
    setAttachments([]);
    setDismissed(false);
    closeMenus();
    focusInput();
  };

  const toggleListen = () => {
    if (listening) {
      dictation.current += 1;
      setListening(false);
      return;
    }
    const seq = ++dictation.current;
    setListening(true);
    Promise.resolve(latest.current.onDictate?.()).then(
      text => {
        if (seq !== dictation.current) return;
        setListening(false);
        if (text) setDraft(d => (d.trim() ? `${d.trimEnd()} ${text}` : text));
        focusInput();
      },
      () => {
        if (seq === dictation.current) setListening(false);
      }
    );
  };

  const onKeyDown = e => {
    if (open && list.length) {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        setActive((cursor + (e.key === 'ArrowDown' ? 1 : list.length - 1)) % list.length);
        return;
      }
      if ((e.key === 'Enter' && !e.shiftKey) || e.key === 'Tab') {
        e.preventDefault();
        pick(list[cursor]);
        return;
      }
      if (open === 'model' && e.key === 'Delete' && list[cursor]?.saved && latest.current.onDeleteModel) {
        e.preventDefault();
        latest.current.onDeleteModel(list[cursor]);
        return;
      }
    }
    if (e.key === 'Escape') {
      if (open) {
        e.preventDefault();
        setDismissed(true);
        closeMenus();
      }
      return;
    }
    if (e.key === 'Enter' && e.currentTarget?.classList?.contains('prompt-bar__model-search')) {
      e.preventDefault();
      return;
    }
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      send();
    }
  };

  const down = e => {
    if (e.button !== 0 || !armed) return;
    setPressed(true);
  };
  const up = () => setPressed(false);

  return (
    <div
      ref={rootRef}
      className={`prompt-bar${className ? ` ${className}` : ''}`}
      data-busy={busy ? '' : undefined}
      data-max={maxed ? '' : undefined}
      data-drag={dragging ? '' : undefined}
      onDragOver={e => {
        if (!e.dataTransfer?.types?.includes('Files')) return;
        e.preventDefault();
        setDragging(true);
      }}
      onDragLeave={e => {
        if (e.currentTarget.contains(e.relatedTarget)) return;
        setDragging(false);
      }}
      onDrop={e => {
        if (!e.dataTransfer?.types?.includes('Files')) return;
        e.preventDefault();
        setDragging(false);
        collectFiles(e.dataTransfer.files);
        focusInput();
      }}
      style={{
        '--pb-bg': background,
        '--pb-ink': color,
        '--pb-menu': menuBackground,
        '--pb-w': `${width}px`,
        '--pb-radius': `${radius}px`,
        '--pb-spark': sparkColor,
        '--pb-press': pressScale
      }}
    >
      {open ? (
        <div
          className="prompt-bar__menu"
          role={open === 'effort' ? 'dialog' : 'listbox'}
          aria-label={
            open === 'at' ? 'Sources' : open === 'slash' ? 'Commands' : open === 'model' ? 'Models' : 'Response style'
          }
          data-kind={open}
          style={open === 'model' ? { maxHeight: `${modelMenuMaxHeight}px` } : undefined}
        >
          {open === 'effort' ? (
            <>
              <div className="prompt-bar__effort-head">
                <span className="prompt-bar__effort-title">Response style</span>
                <span className="prompt-bar__effort-level">{level}</span>
                <span className="prompt-bar__effort-help" title="Adjusts response creativity through temperature">
                  <HugeiconsIcon icon={HelpCircleIcon} size={14} strokeWidth={1.8} />
                </span>
              </div>
              <div className="prompt-bar__effort-ends">
                <span>Focused</span>
                <span>Expressive</span>
              </div>
              <div
                className="prompt-bar__effort-track"
                role="slider"
                tabIndex={0}
                aria-label="Response style"
                aria-valuemin={0}
                aria-valuemax={efforts.length - 1}
                aria-valuenow={effortIndex}
                aria-valuetext={level}
                style={{ '--pb-effort-x': stepAt(effortIndex), '--pb-effort-fill': fillAt(effortIndex) }}
                onPointerDown={e => {
                  if (e.button !== 0) return;
                  try {
                    e.currentTarget.setPointerCapture(e.pointerId);
                  } catch {}
                  e.currentTarget.focus({ preventScroll: true });
                  effortFromPointer(e);
                }}
                onPointerMove={e => {
                  if (e.buttons & 1) effortFromPointer(e);
                }}
                onKeyDown={onEffortKey}
              >
                <span className="prompt-bar__effort-fill" />
                {efforts.map((label, i) => (
                  <i key={label} className="prompt-bar__effort-dot" style={{ left: stepAt(i) }} />
                ))}
                <span className="prompt-bar__effort-thumb" />
              </div>
            </>
          ) : (
            <>
              {open === 'model' ? (
                <div className="prompt-bar__model-search-wrap">
                  <input
                    className="prompt-bar__model-search"
                    type="search"
                    value={modelQuery}
                    placeholder="Search models or capabilities"
                    aria-label="Search models"
                    autoComplete="off"
                    spellCheck={false}
                    onChange={event => {
                      setModelQuery(event.target.value);
                      setActive(0);
                    }}
                    onKeyDown={onKeyDown}
                  />
                </div>
              ) : null}
              <div className="prompt-bar__list">
                <span ref={glowRef} className="prompt-bar__glow" aria-hidden="true" />
                {list.map((row, i) => {
                  const groupHeader =
                    open === 'model' && row.group && row.group !== list[i - 1]?.group ? row.group : null;
                  return (
                    <Fragment key={row.key}>
                      {groupHeader ? (
                        <div className="prompt-bar__group" role="presentation">
                          {groupHeader}
                        </div>
                      ) : null}
                      {open === 'model' ? (
                        <div
                          ref={el => {
                            rowRefs.current[i] = el;
                          }}
                          role="option"
                          aria-selected={i === cursor}
                          aria-disabled={row.disabled ? 'true' : undefined}
                          data-active={i === cursor ? '' : undefined}
                          data-disabled={row.disabled ? '' : undefined}
                          className="prompt-bar__row prompt-bar__row--model prompt-bar__row--managed"
                          onMouseDown={e => e.preventDefault()}
                          onPointerEnter={() => setActive(i)}
                          onClick={() => pick(row)}
                        >
                          <span className="prompt-bar__model-main">
                            <span className="prompt-bar__model-title">
                              <span
                                className="prompt-bar__row-name"
                                title={row.meta ? `${row.name} - ${row.meta}` : row.name}
                              >
                                {row.name}
                              </span>
                              {row.badge ? <span className={`prompt-bar__model-badge${row.vups ? ' prompt-bar__model-badge--vups' : ''}`}>{row.badge}</span> : null}
                            </span>
                            {row.tag ? <span className="prompt-bar__model-sub">{row.tag}</span> : null}
                            {row.capabilityLabels?.length > 0 ? (
                              <span
                                className="prompt-bar__model-caps"
                                title={`Supported: ${row.capabilityLabels.join(", ")}`}
                              >
                                {row.capabilityLabels.slice(0, 3).map(label => (
                                  <span key={label} className="prompt-bar__model-cap">{label}</span>
                                ))}
                              </span>
                            ) : null}
                            {row.meta ? <span className="prompt-bar__model-meta">{row.meta}</span> : null}
                            {row.capabilityChips?.length > 0 ? (
                              <span className="prompt-bar__vups-chips">
                                {row.capabilityChips.map(label => (
                                  <span key={label} className="prompt-bar__vups-chip">{label}</span>
                                ))}
                              </span>
                            ) : null}
                          </span>
                          {row.saved && onDeleteModel ? (
                            <button
                              type="button"
                              className="prompt-bar__model-delete"
                              aria-label={`Delete saved model ${row.name} for ${row.provider || 'this provider'}`}
                              title="Delete saved model"
                              onMouseDown={e => e.preventDefault()}
                              onClick={e => {
                                e.stopPropagation();
                                onDeleteModel(row);
                              }}
                            >
                              <HugeiconsIcon icon={Delete02Icon} size={14} strokeWidth={2} />
                            </button>
                          ) : null}
                          <span
                            className="prompt-bar__row-check"
                            data-on={!row.disabled && row.key === model?.key ? '' : undefined}
                          >
                            <HugeiconsIcon icon={Tick02Icon} size={13} strokeWidth={2.5} />
                          </span>
                        </div>
                      ) : (
                        <button
                          ref={el => {
                            rowRefs.current[i] = el;
                          }}
                          type="button"
                          role="option"
                          aria-selected={i === cursor}
                          className="prompt-bar__row"
                          onMouseDown={e => e.preventDefault()}
                          onPointerEnter={() => setActive(i)}
                          onClick={() => pick(row)}
                        >
                          {open === 'at' ? <span className="prompt-bar__row-icon">{renderIcon(row.icon, 15)}</span> : null}
                          <span className="prompt-bar__row-name">{row.name}</span>
                          {row.description ? <span className="prompt-bar__row-desc">{row.description}</span> : null}
                        </button>
                      )}
                    </Fragment>
                  );
                })}
                {list.length === 0 ? (
                  <div className="prompt-bar__empty">
                    {open === 'model' ? `No models match "${modelQuery.trim()}"` : `No matches for "${query}"`}
                  </div>
                ) : null}
              </div>
              {open === 'model' && onAddKey ? (
                <button
                  type="button"
                  className="prompt-bar__menu-add"
                  onMouseDown={e => e.preventDefault()}
                  onClick={() => {
                    closeMenus();
                    onAddKey();
                  }}
                >
                  <HugeiconsIcon icon={Key01Icon} size={14} strokeWidth={2} />
                  <span>+ Add API key</span>
                </button>
              ) : null}
            </>
          )}
        </div>
      ) : null}

      <div
        className="prompt-bar__field"
        role="presentation"
        data-max={maxed ? '' : undefined}
        onPointerDown={e => {
          if (e.target === e.currentTarget || e.target === inputRef.current) closeMenus();
        }}
        onClick={focusInput}
      >
        <canvas ref={sparkRef} className="prompt-bar__sparks" aria-hidden="true" />
        {attachments.length > 0 ? (
          <div className="prompt-bar__chips">
            {attachments.map((item, i) => {
              const isItem = item && typeof item === 'object';
              const label = isItem ? item.name || 'image' : String(item);
              const thumb = isItem ? item.dataUrl || item.previewUrl : null;
              const failed = isItem && item.status === 'error';
              return (
                <span
                  key={isItem ? item.id ?? i : `${item}-${i}`}
                  className={`prompt-bar__chip${thumb ? ' prompt-bar__chip--image' : ''}`}
                  data-error={failed ? '' : undefined}
                  title={failed ? item.error || label : label}
                >
                  {thumb ? (
                    <span className="prompt-bar__chip-thumb" aria-hidden="true">
                      <img src={thumb} alt="" />
                    </span>
                  ) : (
                    <HugeiconsIcon icon={File02Icon} size={12} strokeWidth={2} />
                  )}
                  <span className="prompt-bar__chip-name">{label}</span>
                  <button
                    type="button"
                    className="prompt-bar__chip-x"
                    aria-label={`Remove ${label}`}
                    onClick={() => setAttachments(a => a.filter((_, j) => j !== i))}
                  >
                    <HugeiconsIcon icon={Cancel01Icon} size={10} strokeWidth={2.5} />
                  </button>
                </span>
              );
            })}
          </div>
        ) : null}

        <textarea
          ref={inputRef}
          className="prompt-bar__input"
          rows={1}
          value={draft}
          placeholder={listening ? 'Listening…' : placeholder}
          aria-label="Prompt"
          onChange={e => {
            setDraft(e.target.value);
            typing.current.energy = Math.min(1.6, typing.current.energy + 0.22);
            typing.current.strokes = Math.min(4, typing.current.strokes + 1);
            setDismissed(false);
            closeMenus();
            setActive(0);
          }}
          onFocus={closeMenus}
          onKeyDown={onKeyDown}
          onPaste={e => {
            const files = [...(e.clipboardData?.files || [])].filter(
              file => file && typeof file.type === 'string' && file.type.startsWith('image/')
            );
            if (files.length === 0) return;
            e.preventDefault();
            collectFiles(files);
          }}
        />

        <div className="prompt-bar__bar">
          {models.length > 0 ? (
            <button
              type="button"
              className="prompt-bar__pick prompt-bar__pick--model"
              aria-label={`Choose model, currently ${model.name}`}
              title={model.name}
              aria-expanded={modelOpen}
              data-on={modelOpen ? '' : undefined}
              onMouseDown={e => e.preventDefault()}
              onClick={() => {
                focusInput();
                setPlusOpen(false);
                setEffortOpen(false);
                setActive(Math.max(0, models.indexOf(model)));
                setModelOpen(v => !v);
              }}
            >
              <span title={model.name}>{model.name}</span>
              <HugeiconsIcon icon={ArrowDown01Icon} size={12} strokeWidth={2.4} />
            </button>
          ) : null}
          {efforts.length > 0 ? (
            <button
              type="button"
              className="prompt-bar__pick"
              aria-label="Choose response style"
              aria-expanded={effortOpen}
              data-on={effortOpen ? '' : undefined}
              data-max={maxed ? '' : undefined}
              onMouseDown={e => e.preventDefault()}
              onClick={() => {
                focusInput();
                setPlusOpen(false);
                setModelOpen(false);
                setEffortOpen(v => !v);
              }}
            >
              <HugeiconsIcon icon={SparklesIcon} size={13} strokeWidth={2} />
              <span>{level}</span>
            </button>
          ) : null}
          {onGenerateImage ? (
            <button
              type="button"
              className="prompt-bar__pick prompt-bar__generate"
              aria-label="Generate an image from the prompt"
              title="Generate an image from the prompt"
              disabled={!canGenerate}
              onMouseDown={e => e.preventDefault()}
              onClick={() => {
                if (!canGenerate) return;
                closeMenus();
                latest.current.onGenerateImage?.(draft.trim());
              }}
            >
              <HugeiconsIcon icon={SparklesIcon} size={13} strokeWidth={2} />
              <span>Image</span>
            </button>
          ) : null}
          <span className="prompt-bar__spacer" />
          <button
            type="button"
            className="prompt-bar__tool"
            aria-label="Attach images"
            title="Attach images (PNG, JPEG, WebP, GIF)"
            onMouseDown={e => e.preventDefault()}
            onClick={() => {
              focusInput();
              closeMenus();
              fileInputRef.current?.click();
            }}
          >
            <HugeiconsIcon icon={Attachment01Icon} size={15} strokeWidth={2} />
          </button>
          {onDictate ? (
            <button
              type="button"
              className="prompt-bar__tool"
              aria-label={listening ? 'Stop dictation' : 'Dictate'}
              aria-pressed={listening}
              data-on={listening ? '' : undefined}
              onMouseDown={e => e.preventDefault()}
              onClick={toggleListen}
            >
              {listening ? (
                <span className="prompt-bar__eq" aria-hidden="true">
                  <i />
                  <i />
                  <i />
                </span>
              ) : (
                <HugeiconsIcon icon={Mic01Icon} size={15} strokeWidth={2} />
              )}
            </button>
          ) : null}
          <button
            type="button"
            className="prompt-bar__send"
            disabled={!armed}
            aria-label={busy ? 'Stop' : 'Send'}
            data-armed={armed ? '' : undefined}
            data-pressed={pressed ? '' : undefined}
            onMouseDown={e => e.preventDefault()}
            onPointerDown={down}
            onPointerUp={up}
            onPointerCancel={up}
            onPointerLeave={up}
            onClick={() => {
              if (busy) latest.current.onStop?.();
              else send();
            }}
          >
            <SendGlyph busy={busy} morphDuration={morphDuration} squash={squash} tilt={tilt} />
          </button>
        </div>
      </div>
      <input
        ref={fileInputRef}
        className="prompt-bar__file"
        type="file"
        accept="image/png,image/jpeg,image/webp,image/gif"
        multiple
        hidden
        onChange={e => {
          collectFiles(e.target.files);
          e.target.value = '';
        }}
      />
    </div>
  );
}
