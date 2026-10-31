import { Fragment, isValidElement, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { animate, useMotionValue, useMotionValueEvent, useReducedMotion } from 'motion/react';
import { HugeiconsIcon } from '@hugeicons/react';
import {
  ArrowDown01Icon,
  Attachment01Icon,
  Camera01Icon,
  Cancel01Icon,
  Delete02Icon,
  Edit01Icon,
  File02Icon,
  FolderAddIcon,
  HelpCircleIcon,
  Key01Icon,
  Mic01Icon,
  SparklesIcon,
  StarIcon,
  Tick02Icon
} from '@hugeicons/core-free-icons';
import {
  PASTE_MIN_BYTES,
  PASTE_TYPE_LABEL,
  formatPromptSize,
  isLongPaste,
  isPastedTextAttachment,
  pastedTextAttachment,
  pastedTextPreview,
  utf8ByteLength,
  withPastedTextContent
} from '../../chat/pastedText.js';
import {
  MODEL_FILTERS,
  filterEmptyMessage,
  filterModelRows,
  loadSavedModelIds,
  matchesModelQuery,
  missingSavedModelCount,
  savedModelId,
  saveSavedModelIds,
  toggleSavedModel
} from '../../chat/savedModels.js';
import './PromptBar.css';

const ARROW_UP = [12, 4.5, 18.5, 11, 14.25, 11, 14.25, 19.5, 9.75, 19.5, 9.75, 11, 5.5, 11];
const SQUARE = [12, 6, 18, 6, 18, 12, 18, 18, 6, 18, 6, 12, 6, 6];
const EASE_IN_OUT = [0.77, 0, 0.175, 1];
const LINE = 22;
const EDGE = 11;

const DEFAULT_MODELS = [];
const DEFAULT_EFFORTS = ['Precise', 'Balanced', 'Creative'];

const chipSize = bytes => {
  const value = Number(bytes);
  if (!Number.isFinite(value) || value <= 0) return '';
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(value < 10240 ? 1 : 0)} KB`;
  return `${(value / (1024 * 1024)).toFixed(1)} MB`;
};

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
  permissionControl = null,
  attachmentMode = 'images',
  sendWithModifier = false,
  externalFiles = null,
  externalFilesSignal = 0,
  draftValue = '',
  draftSignal = 0,
  attachmentAccept = 'image/png,image/jpeg,image/webp,image/gif',
  pasteMinBytes = PASTE_MIN_BYTES,
  showCamera = false,
  showFolder = false,
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
  const cameraInputRef = useRef(null);
  const folderInputRef = useRef(null);
  const sendingCheck = useRef(false);
  const glowRef = useRef(null);
  const sparkRef = useRef(null);
  const typing = useRef({ energy: 0, strokes: 0 });
  const boost = useRef(sparkBoost);
  boost.current = sparkBoost;
  const rowRefs = useRef([]);
  const lastOpen = useRef(null);
  const dictation = useRef(0);
  const lastExternalFiles = useRef(0);
  const lastDraftSignal = useRef(0);
  const latest = useRef({});
  latest.current = {
    onSend,
    beforeSend,
    onStop,
    onGenerateImage,
    onAttach,
    onDictate,
    onEffortChange,
    onModelChange,
    onDeleteModel,
    onAddKey,
    attachmentMode
  };

  const [draft, setDraft] = useState('');
  const [attachments, setAttachments] = useState([]);
  const [pasteView, setPasteView] = useState(null);
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
  const [modelFilter, setModelFilter] = useState('all');
  const [savedIds, setSavedIds] = useState(() => loadSavedModelIds());
  const savedSet = useMemo(() => new Set(savedIds), [savedIds]);
  const [listening, setListening] = useState(false);
  const [pressed, setPressed] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [modelMenuMaxHeight, setModelMenuMaxHeight] = useState(360);

  const model = models.find(m => m.key === modelKey) ?? models[0];
  useEffect(() => {
    if (!draftSignal || draftSignal === lastDraftSignal.current) return;
    lastDraftSignal.current = draftSignal;
    if (typeof draftValue === 'string') setDraft(draftValue);
    requestAnimationFrame(() => inputRef.current?.focus({ preventScroll: true }));
  }, [draftSignal, draftValue]);
  useEffect(() => {
    if (!showFolder) return;
    folderInputRef.current?.setAttribute('webkitdirectory', '');
    folderInputRef.current?.setAttribute('directory', '');
  }, [showFolder]);
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
      const filtered = filterModelRows(models, modelFilter, savedIds);
      return filtered.filter(row => matchesModelQuery(row, modelQuery));
    }
    return [];
  }, [open, query, sources, commands, models, modelQuery, modelFilter, savedIds]);
  const savedMissing = useMemo(() => missingSavedModelCount(models, savedIds), [models, savedIds]);
  const cursor = Math.min(active, Math.max(0, list.length - 1));
  const canSend = draft.trim().length > 0 || attachments.length > 0;
  const canGenerate = draft.trim().length > 0 && !busy && !generating;
  const armed = busy || canSend;
  const level = efforts[effortIndex] ?? '';
  const maxed = efforts.length > 1 && effortIndex === efforts.length - 1;

  const focusInput = () => inputRef.current?.focus({ preventScroll: true });

  const collectFiles = useCallback(fileList => {
    const native = latest.current.attachmentMode === 'native';
    const files = [...(fileList || [])].filter(
      file =>
        file &&
        (native || (typeof file.type === 'string' && file.type.startsWith('image/')))
    );
    if (files.length === 0) return;
    Promise.resolve(latest.current.onAttach?.(files)).then(items => {
      if (!items) return;
      setAttachments(current => [...current, ...(Array.isArray(items) ? items : [items])]);
    }).catch(() => {});
  }, []);

  useEffect(() => {
    if (!externalFilesSignal || externalFilesSignal === lastExternalFiles.current) return;
    lastExternalFiles.current = externalFilesSignal;
    if (externalFiles?.length) collectFiles(externalFiles);
  }, [externalFilesSignal, externalFiles, collectFiles]);

  const removeAttachment = index => {
    const target = attachments[index];
    setAttachments(current => current.filter((_, j) => j !== index));
    if (target && pasteView?.id === target.id) setPasteView(null);
  };

  const savePastedText = () => {
    if (!pasteView) return;
    const edited = pasteView.text;
    if (edited.trim()) {
      setAttachments(current =>
        current.map(item => (item.id === pasteView.id ? withPastedTextContent(item, edited) : item))
      );
    } else {
      setAttachments(current => current.filter(item => item.id !== pasteView.id));
    }
    setPasteView(null);
    focusInput();
  };

  const pastePreview =
    pasteView && pasteView.mode !== 'edit'
      ? pastedTextPreview({ text: pasteView.text })
      : { text: '', truncated: false };

  useEffect(() => {
    if (!pasteView) return undefined;
    const onKey = event => {
      if (event.key !== 'Escape') return;
      event.stopPropagation();
      setPasteView(null);
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [pasteView]);

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

  const toggleModelSaved = row => {
    const next = toggleSavedModel(row, savedIds);
    setSavedIds(next.ids);
    saveSavedModelIds(next.ids);
  };

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

  const send = async () => {
    if (!canSend || busy || sendingCheck.current) return;
    sendingCheck.current = true;
    try {
      const allowed = await latest.current.beforeSend?.(draft.trim(), attachments);
      if (allowed === false) return;
      latest.current.onSend?.(draft.trim(), { attachments, model, effort: level });
      setDraft('');
      setAttachments([]);
      setPasteView(null);
      setDismissed(false);
      closeMenus();
      focusInput();
    } catch {
      /* keep the draft when permission or validation cannot be completed */
    } finally {
      sendingCheck.current = false;
    }
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
        closeMenus();
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
      if (sendWithModifier && !(e.ctrlKey || e.metaKey)) return;
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
                <>
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
                  <div className="prompt-bar__model-filters" role="group" aria-label="Filter models">
                    {MODEL_FILTERS.map(filter => (
                      <button
                        key={filter.id}
                        type="button"
                        className="prompt-bar__model-filter"
                        aria-pressed={modelFilter === filter.id}
                        onMouseDown={e => e.preventDefault()}
                        onClick={() => {
                          setModelFilter(filter.id);
                          setActive(0);
                        }}
                      >
                        {filter.label}
                        {filter.id === 'saved' && savedIds.length > 0 ? (
                          <span className="prompt-bar__model-filter-count">{savedIds.length}</span>
                        ) : null}
                      </button>
                    ))}
                  </div>
                </>
              ) : null}
              <div className="prompt-bar__list">
                <span ref={glowRef} className="prompt-bar__glow" aria-hidden="true" />
                {list.map((row, i) => {
                  const groupHeader =
                    open === 'model' && row.group && row.group !== list[i - 1]?.group ? row.group : null;
                  const starred = savedSet.has(savedModelId(row));
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
                            {row.model && row.model !== row.name ? (
                              <span className="prompt-bar__model-id">{row.model}</span>
                            ) : null}
                            {row.capabilityChips?.length > 0 ? (
                              <span className="prompt-bar__vups-chips">
                                {row.capabilityChips.map(label => (
                                  <span key={label} className="prompt-bar__vups-chip">{label}</span>
                                ))}
                              </span>
                            ) : null}
                          </span>
                          {!row.disabled && row.model ? (
                            <button
                              type="button"
                              className="prompt-bar__model-star"
                              data-on={starred ? '' : undefined}
                              aria-pressed={starred}
                              aria-label={
                                starred
                                  ? `Remove ${row.name} from saved models`
                                  : `Save ${row.name} to saved models`
                              }
                              title={starred ? 'Remove from saved models' : 'Save model'}
                              onMouseDown={e => e.preventDefault()}
                              onClick={e => {
                                e.stopPropagation();
                                toggleModelSaved(row);
                              }}
                            >
                              <HugeiconsIcon
                                icon={StarIcon}
                                size={14}
                                strokeWidth={starred ? 2.6 : 2}
                              />
                            </button>
                          ) : null}
                          {row.saved && onDeleteModel ? (
                            <button
                              type="button"
                              className="prompt-bar__model-delete"
                              aria-label={`Delete saved model ${row.name} for ${row.provider || 'this provider'}`}
                              title="Delete saved model"
                              onMouseDown={e => e.preventDefault()}
                              onClick={e => {
                                e.stopPropagation();
                                closeMenus();
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
                    {open === 'model'
                      ? filterEmptyMessage(modelFilter, {
                          query: modelQuery,
                          savedCount: savedIds.length
                        })
                      : `No matches for "${query}"`}
                  </div>
                ) : null}
                {open === 'model' && modelFilter === 'saved' && list.length > 0 && savedMissing > 0 ? (
                  <div className="prompt-bar__empty" role="status">
                    {savedMissing === 1
                      ? '1 saved model is not in the current catalogue.'
                      : `${savedMissing} saved models are not in the current catalogue.`}
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
        {pasteView ? (
          <div className="prompt-bar__paste" role="group" aria-label="Pasted prompt preview">
            <div className="prompt-bar__paste-head">
              <span className="prompt-bar__paste-title">
                {attachments.find(item => item?.id === pasteView.id)?.name || 'Pasted prompt'}
              </span>
              <span className="prompt-bar__paste-meta">
                {PASTE_TYPE_LABEL} · {formatPromptSize(utf8ByteLength(pasteView.text))}
              </span>
              <button
                type="button"
                className="prompt-bar__paste-btn"
                onClick={() => {
                  if (pasteView.mode === 'edit') savePastedText();
                  else setPasteView(v => ({ ...v, mode: 'edit' }));
                }}
              >
                {pasteView.mode === 'edit' ? 'Save' : 'Edit'}
              </button>
              <button
                type="button"
                className="prompt-bar__paste-btn"
                onClick={() => setPasteView(null)}
                aria-label="Close preview; the pasted prompt stays attached"
              >
                Close
              </button>
            </div>
            {pasteView.mode === 'edit' ? (
              <textarea
                className="prompt-bar__paste-edit"
                value={pasteView.text}
                onChange={event => setPasteView(v => ({ ...v, text: event.target.value }))}
                aria-label="Edit pasted prompt"
                spellCheck={false}
              />
            ) : (
              <pre className="prompt-bar__paste-text">
                {pastePreview.text}
                {pastePreview.truncated
                  ? `\n\n… preview stops after ${pastePreview.text.length.toLocaleString()} characters; Edit shows all ${pasteView.text.length.toLocaleString()}.`
                  : ''}
              </pre>
            )}
          </div>
        ) : null}
        {attachments.length > 0 ? (
          <div className="prompt-bar__chips">
            {attachments.map((item, i) => {
              const isItem = item && typeof item === 'object';
              const label = isItem ? item.name || 'image' : String(item);
              const thumb = isItem ? item.dataUrl || item.previewUrl : null;
              const failed = isItem && item.status === 'error';
              const pasted = isItem && !failed && isPastedTextAttachment(item);
              const size = isItem && item.size ? (pasted ? formatPromptSize(item.size) : chipSize(item.size)) : '';
              if (pasted) {
                return (
                  <span
                    key={item.id ?? i}
                    className="prompt-bar__chip prompt-bar__chip--paste"
                    title={`${label} · ${PASTE_TYPE_LABEL} · ${size}`}
                  >
                    <button
                      type="button"
                      className="prompt-bar__chip-open"
                      aria-expanded={pasteView?.id === item.id}
                      aria-label={`Preview pasted prompt ${label}`}
                      onClick={() => setPasteView({ id: item.id, mode: 'view', text: item.text })}
                    >
                      <HugeiconsIcon icon={File02Icon} size={14} strokeWidth={2} />
                      <span className="prompt-bar__chip-copy">
                        <span className="prompt-bar__chip-name">{label}</span>
                        <span className="prompt-bar__chip-kind">
                          {PASTE_TYPE_LABEL} · {size}
                        </span>
                      </span>
                    </button>
                    <button
                      type="button"
                      className="prompt-bar__chip-x"
                      aria-label={`Remove ${label}`}
                      onClick={() => removeAttachment(i)}
                    >
                      <HugeiconsIcon icon={Cancel01Icon} size={10} strokeWidth={2.5} />
                    </button>
                  </span>
                );
              }
              return (
                <span
                  key={isItem ? item.id ?? i : `${item}-${i}`}
                  className={`prompt-bar__chip${thumb ? ' prompt-bar__chip--image' : ''}`}
                  data-error={failed ? '' : undefined}
                  data-folder={isItem && item.source === 'folder' ? '' : undefined}
                  title={failed ? item.error || label : [label, size].filter(Boolean).join(' · ')}
                >
                  {thumb ? (
                    <span className="prompt-bar__chip-thumb" aria-hidden="true">
                      <img src={thumb} alt="" />
                    </span>
                  ) : (
                    <HugeiconsIcon icon={File02Icon} size={12} strokeWidth={2} />
                  )}
                  <span className="prompt-bar__chip-name">{label}</span>
                  {size ? <span className="prompt-bar__chip-size">{size}</span> : null}
                  <button
                    type="button"
                    className="prompt-bar__chip-x"
                    aria-label={`Remove ${label}`}
                    onClick={() => removeAttachment(i)}
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
              file =>
                file &&
                (attachmentMode === 'native' ||
                  (typeof file.type === 'string' && file.type.startsWith('image/')))
            );
            if (files.length > 0) {
              e.preventDefault();
              collectFiles(files);
              return;
            }
            // A long pasted prompt becomes a compact attachment card; short
            // clipboard text keeps landing in the textarea as ordinary draft.
            const text = e.clipboardData?.getData?.('text') || '';
            if (!isLongPaste(text, pasteMinBytes)) return;
            e.preventDefault();
            setAttachments(current => [...current, pastedTextAttachment(text)]);
            focusInput();
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
          {showCamera ? (
            <button
              type="button"
              className="prompt-bar__tool"
              aria-label="Take photo"
              title="Take a photo"
              onMouseDown={e => e.preventDefault()}
              onClick={() => {
                focusInput();
                closeMenus();
                cameraInputRef.current?.click();
              }}
            >
              <HugeiconsIcon icon={Camera01Icon} size={15} strokeWidth={2} />
            </button>
          ) : null}
          <button
            type="button"
            className="prompt-bar__tool"
            aria-label={attachmentMode === 'native' ? 'Attach files' : 'Attach images'}
            title={attachmentMode === 'native' ? 'Attach files or images' : 'Attach images (PNG, JPEG, WebP, GIF)'}
            onMouseDown={e => e.preventDefault()}
            onClick={() => {
              focusInput();
              closeMenus();
              fileInputRef.current?.click();
            }}
          >
            <HugeiconsIcon icon={Attachment01Icon} size={15} strokeWidth={2} />
          </button>
          {showFolder ? (
            <button
              type="button"
              className="prompt-bar__tool"
              aria-label="Add folder"
              title="Add a folder"
              onMouseDown={e => e.preventDefault()}
              onClick={() => {
                focusInput();
                closeMenus();
                folderInputRef.current?.click();
              }}
            >
              <HugeiconsIcon icon={FolderAddIcon} size={15} strokeWidth={2} />
            </button>
          ) : null}
          {permissionControl ? (
            <div className="prompt-bar__permission" onPointerDown={closeMenus}>
              {permissionControl}
            </div>
          ) : null}
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
        accept={attachmentAccept}
        multiple
        hidden
        onChange={e => {
          collectFiles(e.target.files);
          e.target.value = '';
        }}
      />
      {showCamera ? (
        <input
          ref={cameraInputRef}
          className="prompt-bar__file"
          type="file"
          accept="image/*"
          capture="environment"
          hidden
          onChange={e => {
            collectFiles(e.target.files);
            e.target.value = '';
          }}
        />
      ) : null}
      {showFolder ? (
        <input
          ref={folderInputRef}
          className="prompt-bar__file"
          type="file"
          accept={attachmentAccept}
          multiple
          hidden
          onChange={e => {
            collectFiles(e.target.files);
            e.target.value = '';
          }}
        />
      ) : null}
    </div>
  );
}
