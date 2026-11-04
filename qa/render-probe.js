/* ── the rendered-truth probe ───────────────────────────────────────────────────
   Injected into the real page by qa/guard-render.mjs (addInitScript), so every
   measurement below is what a user actually sees: computed styles after the
   cascade, after MUI's runtime styles, after Tailwind, after inline styles, after
   color-mix() resolved. Nothing in this file reads source code.

   Colours are rasterised through a 1×1 canvas instead of being parsed, because
   `color-mix(in srgb, …)` computes to `color(srgb …)`, P3 and oklab exist, and a
   string parser would quietly skip exactly the values the token system produces.
   The canvas turns any colour Chrome understands into the sRGB bytes that reach
   the screen.

   It installs window.__qaProbe; it decides nothing and fails nothing — the
   verdicts live in the harness. */
(() => {
  const canvas = document.createElement("canvas");
  canvas.width = 1;
  canvas.height = 1;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });

  /* `transparent` is the un-parseable-into-anything-else baseline: if the setter
     rejects the value, fillStyle still reads as it did before. */
  const raster = value => {
    if (!value || value === "none") return null;
    ctx.fillStyle = "transparent";
    const before = ctx.fillStyle;
    ctx.fillStyle = String(value);
    if (ctx.fillStyle === before && !/transparent/i.test(String(value))) return null;
    ctx.clearRect(0, 0, 1, 1);
    ctx.fillRect(0, 0, 1, 1);
    const byte = ctx.getImageData(0, 0, 1, 1).data;
    return { r: byte[0], g: byte[1], b: byte[2], a: byte[3] / 255 };
  };

  const rgba = c => `rgba(${c.r}, ${c.g}, ${c.b}, ${Number(c.a.toFixed(3))})`;

  const hsl = c => {
    const r = c.r / 255;
    const g = c.g / 255;
    const b = c.b / 255;
    const max = Math.max(r, g, b);
    const min = Math.min(r, g, b);
    const delta = max - min;
    if (!delta) return { hue: 0, saturation: 0, lightness: max };
    let hue;
    if (max === r) hue = ((g - b) / delta) % 6;
    else if (max === g) hue = (b - r) / delta + 2;
    else hue = (r - g) / delta + 4;
    hue = Math.round(hue * 60);
    if (hue < 0) hue += 360;
    const l = (max + min) / 2;
    return { hue, saturation: (delta / (1 - Math.abs(2 * l - 1) || 1)) * 100, lightness: l };
  };

  /* The banned blue family: hue 190–280 at more than 10% saturation. A near-grey
     is not "blue", it is a neutral, and the token set has warm neutrals only —
     a grey that measures cool is a leftover. */
  const isBlue = c => {
    if (!c || c.a <= 0.04) return false;
    const { hue, saturation } = hsl(c);
    return hue >= 190 && hue <= 280 && saturation > 10;
  };

  const over = (top, bottom) => {
    const a = top.a;
    return {
      r: Math.round(top.r * a + bottom.r * (1 - a)),
      g: Math.round(top.g * a + bottom.g * (1 - a)),
      b: Math.round(top.b * a + bottom.b * (1 - a)),
      a: 1
    };
  };

  const channel = v => {
    const s = v / 255;
    return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  const luminance = c => 0.2126 * channel(c.r) + 0.7152 * channel(c.g) + 0.0722 * channel(c.b);
  const contrastRatio = (a, b) => {
    const hi = Math.max(luminance(a), luminance(b));
    const lo = Math.min(luminance(a), luminance(b));
    return (hi + 0.05) / (lo + 0.05);
  };

  const label = el => {
    const parts = [];
    let node = el;
    for (let depth = 0; node && node.nodeType === 1 && depth < 4; depth += 1) {
      const name = node.tagName.toLowerCase();
      const id = node.id ? `#${node.id}` : "";
      const classes = [...node.classList]
        .filter(entry => !entry.startsWith("__") && !/^[a-z]+-[A-Za-z0-9]+$/.test(entry))
        .slice(0, 2)
        .map(entry => `.${entry}`)
        .join("");
      parts.unshift(`${name}${id}${classes}`);
      node = node.parentElement;
    }
    return parts.join(" > ");
  };

  const rendered = el => {
    const style = getComputedStyle(el);
    if (style.display === "none" || style.visibility === "hidden") return false;
    if (Number(style.opacity) === 0) return false;
    const box = el.getBoundingClientRect();
    return box.width > 0 || box.height > 0;
  };

  const PAINT_PROPS = [
    "color",
    "background-color",
    "border-top-color",
    "border-right-color",
    "border-bottom-color",
    "border-left-color",
    "outline-color",
    "fill",
    "stroke",
    "text-decoration-color",
    "column-rule-color",
    "caret-color"
  ];

  const LENGTH = /-?[\d.]+(?:px|rem|em)/g;
  const SHADOW_COLOR = /rgba?\([^)]*\)|color\([^)]*\)|hsla?\([^)]*\)|#[0-9a-f]{3,8}/gi;
  const GRADIENT = /(?:linear|radial|conic|repeating-linear|repeating-radial)-gradient\(/i;

  /* Provider identity marks opt out of the blue rule by carrying the same narrow
     exception the static census honours — nothing else does, and the attribute is
     visible in the DOM for a reviewer to count. */
  const brandNode = el => el.closest("[data-brand]");

  /* Two situations put a box past the viewport on purpose, and only two:
     a horizontal scroll region, where the user can reach the rest of it, and a
     marquee, where a box both clips and animates sideways. A `position: fixed`
     element escapes its ancestors' overflow, so the walk stops climbing at it —
     otherwise a shell that sets overflow:hidden would hide every real defect. */
  const inScrollRegion = el => {
    for (let node = el; node && node.nodeType === 1; node = node.parentElement) {
      const style = getComputedStyle(node);
      if (/(auto|scroll)/.test(style.overflowX)) return true;
      if (style.position === "fixed") return false;
      if (node === document.documentElement) break;
    }
    return false;
  };

  const inMarquee = el => {
    for (let node = el; node && node.nodeType === 1; node = node.parentElement) {
      const style = getComputedStyle(node);
      const clips = /(?:^|\s)(?:hidden|clip)(?:\s|$)/.test(style.overflowX);
      const moves =
        Boolean(node.getAnimations && node.getAnimations().length) ||
        (style.animationName && style.animationName !== "none");
      if (clips && moves) return true;
      if (style.position === "fixed") return false;
      if (node === document.documentElement) break;
    }
    return false;
  };

  const opaqueBase = () => {
    const html = raster(getComputedStyle(document.documentElement).backgroundColor);
    const body = raster(getComputedStyle(document.body || document.documentElement).backgroundColor);
    let base = { r: 255, g: 255, b: 255, a: 1 };
    for (const layer of [html, body]) if (layer && layer.a > 0) base = over(layer, base);
    return base;
  };

  /* The background a pixel sits on: every ancestor's own background painted in
     order, each scaled by the opacity of the subtree it belongs to. An element
     painted by a background *image* (the film grain, a photo, a provider logo)
     cannot be measured from colour alone, so it is reported, not assumed. */
  const backdropCache = new WeakMap();
  const backdrop = el => {
    if (backdropCache.has(el)) return backdropCache.get(el);
    const result = measure(el);
    backdropCache.set(el, result);
    return result;
  };

  const measure = el => {
    const style = getComputedStyle(el);
    const parent = el.parentElement && el.parentElement.nodeType === 1 ? el.parentElement : null;
    const under = parent ? backdrop(parent) : { color: opaqueBase(), painted: false };
    if (style.backgroundImage && style.backgroundImage !== "none") {
      return { color: under.color, painted: true };
    }
    const own = raster(style.backgroundColor);
    const opacity = Math.max(0, Math.min(1, Number(style.opacity) || 0));
    if (!own || own.a === 0) return { color: under.color, painted: under.painted };
    const faded = { r: own.r, g: own.g, b: own.b, a: own.a * opacity };
    return { color: over(faded, under.color), painted: under.painted };
  };

  const textUnder = el => {
    const style = getComputedStyle(el);
    const base = backdrop(el);
    const ink = raster(style.color);
    if (!ink) return { ink: null, behind: base.color, painted: base.painted };
    const opacity = Math.max(0, Math.min(1, Number(style.opacity) || 0));
    return {
      ink: over({ r: ink.r, g: ink.g, b: ink.b, a: ink.a * opacity }, base.color),
      behind: base.color,
      painted: base.painted
    };
  };

  const directText = el =>
    [...el.childNodes]
      .filter(node => node.nodeType === 3)
      .map(node => node.textContent)
      .join("")
      .replace(/\s+/g, " ")
      .trim();

  window.__qaProbe = {
    /* Guard 2 — no blue anywhere it can be seen. */
    blue() {
      const found = [];
      let brand = 0;
      for (const el of document.querySelectorAll("*")) {
        if (!rendered(el)) continue;
        if (brandNode(el)) {
          brand += 1;
          continue;
        }
        const style = getComputedStyle(el);
        for (const property of PAINT_PROPS) {
          const colour = raster(style[property]);
          if (isBlue(colour)) {
            found.push({ property, value: `${rgba(colour)} (from ${style[property]})`, where: label(el) });
          }
        }
        const shadow = style.boxShadow && style.boxShadow !== "none" ? style.boxShadow : "";
        for (const raw of shadow.match(SHADOW_COLOR) ?? []) {
          const colour = raster(raw);
          if (isBlue(colour)) found.push({ property: "box-shadow", value: rgba(colour), where: label(el) });
        }
        const caret = style.webkitTextFillColor && style.webkitTextFillColor !== "rgba(0, 0, 0, 0)";
        if (caret) {
          const colour = raster(style.webkitTextFillColor);
          if (isBlue(colour)) found.push({ property: "-webkit-text-fill-color", value: rgba(colour), where: label(el) });
        }
      }
      return { found, brandExempt: brand };
    },

    /* Extra evidence, not one of the five P1 gates: banned *paint* that only
       exists at runtime (a component library's blurred elevation, an inline
       gradient, a backdrop-filter set from JS). Printed so it cannot be missed. */
    paint() {
      const shadows = [];
      const gradients = [];
      const filters = [];
      for (const el of document.querySelectorAll("*")) {
        if (!rendered(el)) continue;
        const style = getComputedStyle(el);
        if (style.boxShadow && style.boxShadow !== "none") {
          for (const layer of style.boxShadow.split(/,(?![^(]*\))/)) {
            const lengths = layer.match(LENGTH) ?? [];
            if (lengths.length >= 3 && parseFloat(lengths[2]) > 0) {
              shadows.push({ layer: layer.trim(), where: label(el) });
            }
          }
        }
        for (const property of ["background", "backgroundImage", "maskImage", "WebkitMaskImage"]) {
          const value = style[property];
          if (value && GRADIENT.test(value) && !/mask/i.test(property)) gradients.push({ value: value.slice(0, 90), where: label(el) });
        }
        if (style.backdropFilter && style.backdropFilter !== "none") {
          filters.push({ value: style.backdropFilter, where: label(el) });
        }
        if (style.filter && /blur\(/.test(style.filter)) {
          filters.push({ value: style.filter, where: label(el) });
        }
      }
      return { shadows, gradients, filters };
    },

    /* Guard 3 — nothing cut off by the viewport. */
    clip() {
      const width = window.innerWidth;
      const found = [];
      const doc = document.documentElement;
      for (const el of document.querySelectorAll("*")) {
        if (!rendered(el)) continue;
        const box = el.getBoundingClientRect();
        if (box.width < 1 || box.height < 1) continue;
        if (box.right <= 0 || box.left >= width) continue;
        const pastLeft = box.left < -0.5;
        const pastRight = box.right > width + 0.5;
        if (!pastLeft && !pastRight) continue;
        if (el.closest("[aria-hidden='true']")) continue;
        if (inScrollRegion(el) || inMarquee(el)) continue;
        found.push({
          side: pastLeft ? "left" : "right",
          box: { left: Math.round(box.left), right: Math.round(box.right), width: Math.round(box.width) },
          viewport: width,
          where: label(el),
          text: (directText(el) || el.textContent || "").replace(/\s+/g, " ").trim().slice(0, 40)
        });
      }
      return {
        found,
        document: { scrollWidth: doc.scrollWidth, clientWidth: doc.clientWidth },
        body: { scrollWidth: document.body ? document.body.scrollWidth : 0 }
      };
    },

    /* Guard 4 — the custom WCAG walk. axe-core runs on top of this; it does not
       replace it, because axe only knows about a handful of colour pairs and this
       walk composites every ancestor stack and every opacity in between. */
    contrast(limit) {
      const found = [];
      const painted = [];
      let checked = 0;
      /* The reference colours arrive as colours, not as pre-converted numbers, so
         they are measured by this file's own luminance function. */
      const inkLimit = limit ? luminance(raster(limit.ink)) : null;
      const backgroundLimit = limit ? luminance(raster(limit.background)) : null;
      const largeish = size => size >= 24;
      for (const el of document.querySelectorAll("body, body *")) {
        if (el.tagName === "SCRIPT" || el.tagName === "STYLE" || el.tagName === "NOSCRIPT") continue;
        if (!rendered(el)) continue;
        const text = directText(el);
        if (!text) continue;
        const style = getComputedStyle(el);
        const size = parseFloat(style.fontSize) || 16;
        const weight = Number(style.fontWeight) || 400;
        /* Bold alone is not "large text" — WCAG needs 18.66px *and* 700. */
        const large = largeish(size) || (size >= 18.66 && weight >= 700);
        const need = large ? 3 : 4.5;
        const { ink, behind, painted: viaImage } = textUnder(el);
        if (!ink) {
          found.push({ reason: "unparseable colour", value: style.color, where: label(el), text: text.slice(0, 40) });
          continue;
        }
        checked += 1;
        const ratio = Number(contrastRatio(ink, behind).toFixed(2));
        if (viaImage) {
          painted.push({ where: label(el), text: text.slice(0, 40), ratio });
          continue;
        }
        const flags = [];
        if (ratio < need) flags.push(`below ${need}:1 AA`);
        /* The addendum names two wash-out references, but read literally they
           reject the palette the same brief mandates: dark's body ink #edeae3 is
           lighter than #cfcbc0, and every light surface (#f4f1ea, #fbf9f4,
           #f0ece2) is lighter than #e0dcd0. Each rule therefore runs in the theme
           where its own palette cannot collide with it — an ink knocked back
           toward white is a light-theme defect (light inks are meant to be dark),
           a pale slab under text is a dark-theme defect (dark surfaces are meant
           to be dark). qa/audit/guard-render.json records the deviation. */
        const theme = document.documentElement.dataset.theme;
        if (limit && theme === "light" && luminance(ink) > inkLimit) {
          flags.push("ink washed out toward white");
        }
        if (limit && theme === "dark" && luminance(behind) > backgroundLimit) {
          flags.push("background lighter than the palette allows");
        }
        if (flags.length) {
          found.push({
            flags,
            ratio,
            need,
            size: `${size}px ${weight}`,
            ink: rgba(ink),
            behind: rgba(behind),
            where: label(el),
            text: text.slice(0, 40)
          });
        }
      }
      /* Placeholders are real text a user has to read before they type. */
      for (const el of document.querySelectorAll("input, textarea")) {
        if (!rendered(el)) continue;
        const placeholder = el.getAttribute("placeholder");
        if (!placeholder) continue;
        const style = getComputedStyle(el, "::placeholder");
        const ink = raster(style.color);
        if (!ink) continue;
        const behind = backdrop(el).color;
        const ratio = Number(contrastRatio(over(ink, behind), behind).toFixed(2));
        checked += 1;
        if (ratio < 4.5) {
          found.push({
            flags: ["placeholder below 4.5:1 AA"],
            ratio,
            need: 4.5,
            size: `${parseFloat(style.fontSize) || 16}px 400`,
            ink: rgba(over(ink, behind)),
            behind: rgba(behind),
            where: `${label(el)}::placeholder`,
            text: placeholder.slice(0, 40)
          });
        }
      }
      return { found, painted, checked };
    }
  };
})();
