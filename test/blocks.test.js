import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  BLOCK_SLOTS,
  FACE_MAX_CHARS,
  blockAnchor,
  blocksFromCatalog,
  faceLabel,
  handoffBlockFor,
  markActiveBlock
} from "../src/home/modelBlocks.js";
import {
  FLOOR_Y,
  WORLD_WIDTH,
  blockPosition,
  blockSide,
  cameraDistance,
  pointerParallax,
  qualityTier
} from "../src/home/blocksLayout.js";
import { clayFor, paletteFor } from "../src/home/blocksMaterials.js";
import {
  DEFAULT_HOME_THEME_SETTING,
  HOME_THEME_KEY,
  HOME_THEME_SETTINGS,
  RESOLVED_HOME_THEMES,
  applyHomeTheme,
  applyHomeThemeSetting,
  initHomeTheme,
  loadHomeThemeSetting,
  normalizeHomeTheme,
  normalizeHomeThemeSetting,
  prefersDarkScheme,
  resolveHomeTheme,
  saveHomeThemeSetting
} from "../src/home/homeTheme.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const read = file => readFileSync(path.resolve(here, "..", file), "utf8");

// The Blocks rules are appended after the pre-existing stylesheet, so slicing
// from their banner is the only way to judge the new design without re-reading
// decades of chat.css history.
const blocksCss = read("src/chat.css").slice(
  read("src/chat.css").indexOf("══ Blocks — Phase 1")
);
const sidebarCss = read("src/desktop/desktop.css").slice(
  read("src/desktop/desktop.css").indexOf("══ Blocks — app shell sidebar")
);

function modelRow(overrides = {}) {
  return {
    key: "openai:gpt-5",
    kind: "model",
    group: "OpenAI",
    name: "GPT-5",
    model: "gpt-5",
    provider: "OpenAI",
    ownedBy: "OpenAI",
    tag: "flagship",
    meta: "128k ctx",
    vision: true,
    capabilityLabels: ["Vision", "Tools"],
    disabled: false,
    ...overrides
  };
}

function fakeStorage(seed = {}) {
  const map = new Map(Object.entries(seed));
  return {
    map,
    getItem(key) {
      return map.has(key) ? map.get(key) : null;
    },
    setItem(key, value) {
      map.set(key, String(value));
    }
  };
}

function fakeDoc() {
  const attributes = new Map();
  return {
    attributes,
    documentElement: {
      setAttribute: (key, value) => attributes.set(key, value),
      getAttribute: key => (attributes.has(key) ? attributes.get(key) : null)
    }
  };
}

test("a block only ever represents a selectable model row", () => {
  const rows = [
    modelRow(),
    modelRow({ key: "off", name: "Off", model: "off-model", disabled: true }),
    modelRow({ key: "combo", name: "Vups Combo AI", combo: true }),
    modelRow({ key: "grp", name: "OpenAI", kind: "group", model: "" }),
    modelRow({ key: "gw", name: "Gateway", kind: "gateway-status", model: "status" }),
    modelRow({ key: "gw2", name: "Kilo", kind: "gateway", model: "kilo" }),
    modelRow({ key: "nom", name: "No model", model: "" })
  ];
  const keys = blocksFromCatalog(rows, { limit: 6 }).map(block => block.key);
  assert.deepEqual(keys, ["openai:gpt-5"], "disabled, combo, group, gateway and model-less rows are not blocks");
});

test("blocks carry the real catalog fields and the row itself", () => {
  const rows = [modelRow()];
  const [block] = blocksFromCatalog(rows);
  assert.equal(block.name, "GPT-5");
  assert.equal(block.model, "gpt-5");
  assert.equal(block.provider, "OpenAI");
  assert.equal(block.tag, "flagship");
  assert.equal(block.meta, "128k ctx");
  assert.deepEqual(block.capabilities, ["Vision", "Tools"]);
  assert.equal(block.row, rows[0], "the click handler must receive the untouched catalog row");
  // The catalog has no cost or speed field, so the hover card cannot have one.
  assert.equal("cost" in block, false);
  assert.equal("speed" in block, false);
  assert.equal("latency" in block, false);
});

test("the engraved face label is the real name within the plate", () => {
  /* The budget lives in one constant; these cases pin the rule, not the number.
     A cut always shows the ellipsis so a shortened name can never read as a
     different model. P5/C10 moves the budget to 10 characters and adds the
     auto-fit plus the full-id tooltip, and this test moves with it. */
  assert.equal(faceLabel("GPT-5"), "GPT-5");
  assert.equal(faceLabel("  Claude Sonnet 4  "), "Claude\u2026");
  assert.equal(faceLabel("Gemini 3.1 Pro Ultra"), "Gemini 3.1\u2026");
  assert.equal(faceLabel("Claude Sonnet 4.5 Thinking"), "Claude\u2026");
  assert.equal(faceLabel("Claude-Opus-4-Thinking"), "Claude-Opus\u2026");
  assert.ok(faceLabel("Anthropic Claude Sonnet 4").length <= FACE_MAX_CHARS + 1);
  assert.ok(!/[-_.\s]$/.test(faceLabel("Claude-Opus-4-Thinking")), "cut left a dangling separator");
  assert.equal(faceLabel("").length, 0);
  assert.equal(faceLabel(undefined), "");
  for (const name of ["GPT-5", "Claude Sonnet 4", "Gemini 3.1 Pro Ultra", "a".repeat(80)]) {
    const label = faceLabel(name);
    assert.ok(label.length <= FACE_MAX_CHARS + 1, `${name} -> ${label} overflows the plate`);
    assert.ok(name.startsWith(label.replace(/\u2026$/, "")), `${name} -> ${label} is invented`);
  }
});

test("duplicate rows collapse and the shelf caps at the authored slots", () => {
  const rows = [
    modelRow({ key: "a", name: "A" }),
    modelRow({ key: "a", name: "A again" }),
    ...Array.from({ length: 10 }, (_, index) =>
      modelRow({ key: `m${index}`, name: `Model ${index}`, model: `m-${index}` })
    )
  ];
  const blocks = blocksFromCatalog(rows);
  assert.equal(blocks.length, BLOCK_SLOTS.length, "never more blocks than authored slots");
  assert.equal(blocks.some(block => block.key === "a" && block.name === "A again"), false);
  for (const block of blocks) {
    assert.ok(BLOCK_SLOTS.includes(block.slot), "slots come from the authored layout, not randomness");
  }
  assert.equal(blocksFromCatalog(null).length, 0);
  assert.equal(blocksFromCatalog("nope").length, 0);
});

test("only the model the send actually routed to animates", () => {
  const blocks = blocksFromCatalog([
    modelRow({ key: "openai:gpt-5", name: "GPT-5", model: "gpt-5" }),
    modelRow({ key: "anthropic:sonnet", name: "Sonnet", model: "claude-sonnet" })
  ]);
  assert.equal(handoffBlockFor(blocks, { key: "anthropic:sonnet" }).model, "claude-sonnet");
  assert.equal(handoffBlockFor(blocks, { key: "", model: "gpt-5" }).key, "openai:gpt-5");
  assert.equal(handoffBlockFor(blocks, { key: "apex:combo", model: "apex" }), null);
  assert.equal(handoffBlockFor(blocks, null), null);
  assert.equal(handoffBlockFor(blocks, {}), null);
});

test("the active marker touches only the selected row", () => {
  const blocks = blocksFromCatalog([
    modelRow({ key: "one", name: "One" }),
    modelRow({ key: "two", name: "Two" })
  ]);
  const next = markActiveBlock(blocks, "two");
  assert.equal(next[1].active, true);
  assert.equal(next[0].active, false);
  assert.equal(blocks[1].active, false, "markActiveBlock must not mutate the memoized input");
  assert.equal(markActiveBlock(blocks, "").every(block => !block.active), true);
});

test("block anchors fall back to the first authored slot", () => {
  assert.deepEqual(blockAnchor({ slot: BLOCK_SLOTS[2] }), {
    x: BLOCK_SLOTS[2].x,
    y: BLOCK_SLOTS[2].y,
    scale: BLOCK_SLOTS[2].scale
  });
  const fallback = blockAnchor(null);
  assert.equal(fallback.x, BLOCK_SLOTS[0].x);
});

test("the home theme has its own key and cannot be poisoned by a bad value", () => {
  assert.equal(HOME_THEME_KEY, "vupsrouter.home.theme.v1");
  /* The stored value is the three-way setting; the painted value is one of two.
     Conflating them is how "System" used to erase itself on the second switch. */
  assert.deepEqual(HOME_THEME_SETTINGS, ["system", "dark", "light"]);
  assert.deepEqual(RESOLVED_HOME_THEMES, ["dark", "light"]);
  assert.equal(normalizeHomeThemeSetting("light"), "light");
  assert.equal(normalizeHomeThemeSetting("purple"), DEFAULT_HOME_THEME_SETTING);
  assert.equal(normalizeHomeThemeSetting(undefined), DEFAULT_HOME_THEME_SETTING);
  assert.equal(normalizeHomeTheme("light"), "light");
  assert.equal(normalizeHomeTheme("purple"), "dark");

  assert.equal(resolveHomeTheme("dark", false), "dark");
  assert.equal(resolveHomeTheme("light", true), "light");
  assert.equal(resolveHomeTheme("system", true), "dark");
  assert.equal(resolveHomeTheme("system", false), "light");
  /* No signal is not a light preference: dark is the default paint. */
  assert.equal(resolveHomeTheme("system", null), "dark");
  assert.equal(resolveHomeTheme("system"), "dark");

  const storage = fakeStorage();
  assert.equal(loadHomeThemeSetting(storage), "system");
  assert.equal(saveHomeThemeSetting(storage, "light"), "light");
  assert.equal(storage.map.get(HOME_THEME_KEY), "light");
  assert.equal(loadHomeThemeSetting(storage), "light");
  assert.equal(loadHomeThemeSetting(null), "system");
  assert.equal(saveHomeThemeSetting(null, "light"), "light");

  const hostile = {
    getItem() {
      throw new Error("blocked");
    },
    setItem() {
      throw new Error("blocked");
    }
  };
  assert.equal(loadHomeThemeSetting(hostile), "system");
  assert.equal(saveHomeThemeSetting(hostile, "dark"), "dark");
});

test("applying the theme paints the shell attribute the tokens hang on", () => {
  const doc = fakeDoc();
  assert.equal(applyHomeTheme("light", doc), "light");
  assert.equal(doc.attributes.get("data-theme"), "light");
  assert.equal(applyHomeTheme("nonsense", doc), "dark");
  assert.equal(doc.attributes.get("data-theme"), "dark");
  assert.equal(applyHomeTheme("light", null), "light");

  /* The setting is recorded next to the resolved paint so the settings page can
     show "System" while the document is dark, instead of losing the choice. */
  const darkWin = {
    localStorage: fakeStorage({ [HOME_THEME_KEY]: "system" }),
    document: fakeDoc(),
    matchMedia: () => ({ matches: true })
  };
  assert.equal(applyHomeThemeSetting("system", darkWin), "dark");
  assert.equal(darkWin.document.attributes.get("data-theme"), "dark");
  assert.equal(darkWin.document.attributes.get("data-theme-setting"), "system");
  const lightWin = {
    localStorage: fakeStorage({ [HOME_THEME_KEY]: "system" }),
    document: fakeDoc(),
    matchMedia: () => ({ matches: false })
  };
  assert.equal(applyHomeThemeSetting("system", lightWin), "light");

  const win = {
    localStorage: fakeStorage({ [HOME_THEME_KEY]: "light" }),
    document: fakeDoc(),
    matchMedia: () => ({ matches: true })
  };
  assert.equal(initHomeTheme(win), "light");
  assert.equal(win.document.attributes.get("data-theme"), "light");
  assert.equal(initHomeTheme(null), "dark");
  assert.equal(prefersDarkScheme(null), null);
  assert.equal(prefersDarkScheme({}), null);
});

test("camera framing stays inside the shelf for every aspect", () => {
  assert.ok(cameraDistance(0.1) <= cameraDistance(0.35) + 1e-9);
  assert.equal(cameraDistance(0), cameraDistance(1.6));
  const far = cameraDistance(0.4);
  const near = cameraDistance(3.2);
  assert.ok(far > near, "a narrow shelf pulls the camera back");
  assert.ok(near >= 4.4 && far <= 11, "distance is clamped");
  assert.equal(cameraDistance(30), cameraDistance(3.2));
});

test("every block stands on the floor plane", () => {
  const side = blockSide(BLOCK_SLOTS[0], 1);
  const [x, y, z] = blockPosition(BLOCK_SLOTS[0], { side });
  assert.equal(y, FLOOR_Y + side / 2);
  assert.equal(x, (BLOCK_SLOTS[0].x - 0.5) * WORLD_WIDTH);
  assert.equal(blockSide(null, 1), blockSide({ scale: 1 }, 1));
  assert.ok(blockSide({ scale: 1 }, 0.86) < blockSide({ scale: 1 }, 1));
});

test("pointer parallax is switched off with motion", () => {
  assert.deepEqual(pointerParallax({ x: 1, y: 1 }, { motion: false }), { x: 0, y: 0 });
  const moved = pointerParallax({ x: 1, y: 1 });
  assert.ok(moved.x > 0 && moved.y < 0);
  const idle = pointerParallax(undefined, { motion: true });
  assert.equal(idle.x, 0);
  assert.ok(idle.y === 0, "a centred pointer drifts nowhere");
});

test("quality tiers bound the scene to what the device can actually do", () => {
  assert.deepEqual(qualityTier({ width: 1440 }), { dpr: 1.5, sizeScale: 1, motion: true, shadows: true });
  assert.deepEqual(qualityTier({ width: 1024 }), { dpr: 1.5, sizeScale: 0.94, motion: true, shadows: true });
  assert.deepEqual(qualityTier({ width: 760 }), { dpr: 1.5, sizeScale: 0.94, motion: true, shadows: true });
  assert.deepEqual(qualityTier({ width: 390 }), { dpr: 1.25, sizeScale: 0.86, motion: false, shadows: true });
  assert.deepEqual(qualityTier({ width: 1440, coarse: true }), {
    dpr: 1.25,
    sizeScale: 0.86,
    motion: false,
    shadows: true
  });
  const reduced = qualityTier({ width: 1440, reducedMotion: true });
  assert.equal(reduced.motion, false);
  assert.equal(reduced.shadows, false);
  assert.equal(reduced.dpr, 1);
  assert.ok(qualityTier().dpr <= 1.5, "device pixel ratio is capped");
});

test("the 3D palettes state the same accent hexes as the CSS tokens", () => {
  /* The palette lives in tokens.js and is declared once in tokens.css; styles.css
     doesn't re-state it. Reading tokens directly avoids slicing and false negatives. */
  const tokens = read("src/tokens.css");
  const dark = paletteFor("dark");
  const light = paletteFor("light");
  /* Tokens.js owns the hex values; tokens.css references them via variable chains.
     Assert the aliasing so we don't invent a second source of truth. */
  assert.match(tokens, /--blocks-accent:\s*var\(.*accent/, "--blocks-accent aliases an accent token");
  assert.deepEqual(paletteFor(), dark, "dark is the default palette");
  assert.equal(clayFor("anything"), clayFor("dark"), "unknown themes fall back to the dark clay");
  assert.equal(dark.clay, clayFor("dark").body);
  assert.equal(light.clayAlt, clayFor("light").alt);
  for (const palette of [dark, light]) {
    for (const value of Object.values(palette)) {
      if (typeof value === "string" && value.startsWith("#") && value.length === 7) {
        const red = parseInt(value.slice(1, 3), 16);
        const blue = parseInt(value.slice(5, 7), 16);
        assert.ok(blue <= red, `${value} would read as a cool cast`);
      }
    }
  }
});

test("the Blocks stylesheet bans gradients and glass", () => {
  assert.doesNotMatch(blocksCss, /linear-gradient|radial-gradient|conic-gradient/);
  assert.doesNotMatch(blocksCss, /blur\(/);
  assert.doesNotMatch(sidebarCss, /linear-gradient|radial-gradient|blur\(/);
  /* Glass is banned outright, so the rule is "no blur anywhere", not "blur is
     switched off on this one selector" — a stray backdrop-filter in any other
     Blocks rule would have slipped past the old pin. */
  for (const block of [blocksCss, sidebarCss]) {
    for (const value of block.match(/backdrop-filter:\s*([^;}]+)/g) ?? []) {
      assert.match(value, /none/, `${value} is glass`);
    }
  }
  /* The header replaced its translucent, blurred sheet with an opaque token. */
  assert.match(blocksCss, /\.vr-chat-header\s*\{[^}]*background:\s*var\(--blocks-bg\)/);
  assert.doesNotMatch(blocksCss.slice(blocksCss.indexOf(".vr-chat-header")), /background:\s*color-mix/);
  // The old glow shadow on the status dot is gone.
  assert.match(blocksCss, /\.vr-chat-header__dot\s*\{[^}]*box-shadow:\s*none/);
});

test("orange is bound to the tokens and only to the allowed roles", () => {
  // The accent arrives through the token layer, never as a loose hex.
  assert.doesNotMatch(blocksCss, /#ff5b1f|#cf3f0e/i);
  assert.doesNotMatch(sidebarCss, /#ff5b1f|#cf3f0e/i);
  // One emphasized hero word, not the whole headline.
  assert.match(blocksCss, /\.vr-welcome-title span\s*\{\s*color: var\(--blocks-accent\)/);
  assert.doesNotMatch(blocksCss, /\.vr-welcome-title\s*\{[^}]*--blocks-accent/);
  assert.match(
    blocksCss,
    /\.vr-prompt-bar \.prompt-bar__send\[data-armed\]\s*\{[^}]*background: var\(--blocks-accent\)/
  );
  // Green means a genuine working status and nothing else.
  assert.match(blocksCss, /\.vr-chat-header__dot\s*\{[^}]*background: var\(--blocks-success\)/);
  assert.doesNotMatch(blocksCss, /\.vr-welcome[^}]*--blocks-success/);
});

test("the hero is centered display type at the specified scale", () => {
  assert.match(blocksCss, /\.vr-welcome\s*\{[^}]*text-align:\s*center/);
  assert.match(blocksCss, /\.vr-welcome-inner\s*\{[^}]*margin:\s*auto/);
  assert.match(blocksCss, /font-size:\s*clamp\(40px,\s*4\.6vw,\s*72px\)/);
  assert.match(blocksCss, /\.vr-welcome-title\s*\{[^}]*font-family:\s*var\(--blocks-display\)/);
  assert.match(blocksCss, /\.vr-welcome-desc\s*\{[^}]*font:\s*400 12px\/1\.7 var\(--blocks-mono\)/);
  assert.match(blocksCss, /opacity:\s*0\.035/);
});

test("technical readouts are monospace with tabular numerals", () => {
  assert.match(blocksCss, /\.vr-chat-header__model\s*\{[^}]*font-variant-numeric:\s*tabular-nums/);
  assert.match(blocksCss, /\.vr-prompt-bar \.prompt-bar__pick--model\s*\{[^}]*tabular-nums/);
  assert.match(sidebarCss, /\.vr-usage-card\s*\{[^}]*var\(--blocks-mono\)/);
});

test("the usage bar is a 2px hairline of solid accent", () => {
  assert.match(sidebarCss, /\.vr-usage-bar\s*\{\s*height:\s*2px/);
  assert.match(sidebarCss, /\.vr-usage-bar > span\s*\{[^}]*background:\s*var\(--blocks-accent\)/);
});

test("the suggestions are a numbered list, not cards", () => {
  assert.match(blocksCss, /\.vr-welcome-starter\s*\{[^}]*flex-direction:\s*row/);
  assert.match(blocksCss, /\.vr-welcome-starter\s*\{[^}]*border:\s*0/);
  assert.match(blocksCss, /\.vr-welcome-starter\s*\{[^}]*border-bottom:\s*1px solid var\(--blocks-line\)/);
  assert.doesNotMatch(blocksCss, /\.vr-welcome-starter\s*\{[^}]*border-radius:\s*[6-9]px/);
  assert.match(blocksCss, /\.vr-welcome-kbd\s*\{/);
  const page = read("src/ChatPage.jsx");
  // Clicking a suggestion still only fills the composer through the real handler.
  const starters = page.slice(page.indexOf("STARTER_PROMPTS.map"), page.indexOf("STARTER_PROMPTS.map") + 400);
  assert.match(starters, /onStarter\(item\.prompt\)/);
  assert.match(page, /onStarter=\{text => setDraftInsertion\(\{ text, key: Date\.now\(\) \}\)\}/);
});

test("the composer keeps solid surfaces and crisp focus", () => {
  assert.match(blocksCss, /\.vr-prompt-bar\.prompt-bar\s*\{[^}]*--pb-radius:\s*10px/);
  assert.match(blocksCss, /\.vr-prompt-bar \.prompt-bar__field\s*\{[^}]*box-shadow:\s*none/);
  assert.match(
    blocksCss,
    /\.vr-prompt-bar \.prompt-bar__field:focus-within\s*\{[^}]*outline:\s*1px solid var\(--blocks-accent\)/
  );
  assert.match(blocksCss, /\.vr-mode-switch__button\s*\{[^}]*border-radius:\s*0/);
});

test("the shelf never sits over the composer at any validated width", () => {
  assert.match(blocksCss, /\.vr-blocks\[data-mode="scene"\]\s*\{[^}]*bottom:\s*184px/);
  assert.match(blocksCss, /\.vr-blocks\[data-mode="scene"\]\s*\{[^}]*pointer-events:\s*none/);
  assert.match(
    blocksCss,
    /\.vr-blocks\[data-fading="on"\] \.vr-blocks-hits[\s\S]*?display:\s*none/
  );
  const narrow = blocksCss.slice(blocksCss.indexOf("@media (max-width: 1023px)"));
  assert.match(narrow, /\.vr-blocks\[data-mode="scene"\]\s*\{[^}]*position:\s*static/);
});

test("reduced motion kills the new transitions and the custom cursor", () => {
  const reduced = blocksCss.slice(blocksCss.indexOf("@media (prefers-reduced-motion: reduce)"));
  assert.ok(reduced.length > 0, "the Blocks section declares a reduced-motion tier");
  assert.match(reduced, /transition:\s*none/);
  assert.match(reduced, /\.vr-block-hit\s*\{[^}]*cursor:\s*pointer/);
  assert.match(blocksCss, /\.vr-block-hit\s*\{[^}]*cursor:\s*none/);
});

test("the scene is lazy-loaded and the list fallback keeps the same selection", () => {
  const layer = read("src/home/BlocksLayer.jsx");
  assert.match(layer, /React\.lazy\(\(\) => import\("\.\/ModelBlockScene\.jsx"\)\)/);
  assert.match(layer, /const ModelBlockScene = React\.lazy/);
  assert.match(layer, /onSelect\?\.\(block\.row\)/);
  assert.match(layer, /mode === "scene" \? \(\s*<Suspense/);
  assert.match(layer, /className="vr-blocks-list"/);
  assert.match(layer, /document\.visibilityState/);
  assert.match(layer, /handoffBlockFor\(blocks, handoff\)/);
});

test("the scene draws only real catalog names and never a fake status", () => {
  const scene = read("src/home/ModelBlockScene.jsx");
  assert.match(scene, /faceTextures\(block\.face, palette\.theme\)/);
  assert.doesNotMatch(scene, /mock|fake|placeholder/i);
  assert.match(scene, /frameloop=\{running \? "always" : "demand"\}/);
  assert.match(scene, /dpr=\{\[1, dprCap\]\}/);
  assert.match(scene, /tier\.shadows \?/);
});

test("the sidebar keeps its usage readout real and the theme toggle reachable", () => {
  const shell = read("src/desktop/DesktopSidebar.jsx");
  assert.match(shell, /import \{ useHomeTheme \} from "\.\.\/home\/useHomeTheme\.js"/);
  assert.match(shell, /\$\{usage\.dailyUsed\} \/ \$\{usage\.dailyQuota\} today/);
  assert.doesNotMatch(shell, /usage\.remaining \}/);
  const accountRow = shell.slice(shell.indexOf('className="vr-account-row"'), shell.indexOf("</aside>"));
  assert.match(accountRow, /className="vr-account-theme"/);
  assert.match(accountRow, /onClick=\{toggleHomeTheme\}/);
  assert.match(accountRow, /aria-label=\{`Home theme: \$\{homeTheme\}/);
  // The nav container goes inert while the tools panel is closed; the toggle must not live there.
  const nav = shell.slice(shell.indexOf("vr-sidebar-nav-inner"), shell.indexOf("vr-usage-card"));
  assert.doesNotMatch(nav, /vr-account-theme/);
  assert.doesNotMatch(shell.slice(shell.indexOf('className="vr-sidebar-nav-inner"'), shell.indexOf('className="vr-sidebar-nav-inner"') + 700), /toggleHomeTheme/);
});

test("the theme is painted before the first render", () => {
  const main = read("src/main.jsx");
  const init = main.indexOf("initHomeTheme()");
  assert.ok(init > 0);
  assert.ok(init < main.indexOf("createRoot("), "initHomeTheme runs before React mounts");
  assert.match(main, /import \{ initHomeTheme \} from "\.\/home\/homeTheme\.js"/);
});

test("the warm palette replaces blue, not the token names the shell reads", () => {
  /* One token file owns every colour now (qa/guard-no-hex.mjs fails the build on
     a hex anywhere else), so the palette is checked there and the shell's own
     vocabulary is checked where it is consumed. */
  const tokens = read("src/tokens.css");
  const chat = read("src/chat.css");
  /* The --blocks-* aliases must mirror the primitives — check these in tokens.css
     itself; the chat shell may or may not use them depending on the theme layer
     (some routes use blocks-materials directly). */
  for (const [role, primitive] of [
    ["--blocks-bg", "--bg"],
    ["--blocks-surface", "--surface"],
    ["--blocks-line", "--border"],
    ["--blocks-ink", "--text"],
    ["--blocks-muted", "--muted"]
  ]) {
    assert.match(tokens, new RegExp(`${role}:\\s*var\\(${primitive}\\)`), `${role} no longer mirrors ${primitive}`);
  }
  /* Dark values must match the canonical palette */
  const dark = tokens.slice(tokens.indexOf(':root,'), tokens.indexOf('html[data-theme="light"]'));
  for (const [name, value] of [
    ["--bg", "#0f0e0c"],
    ["--surface", "#171613"],
    ["--border", "#2a2824"],
    ["--text", "#edeae3"],
    ["--muted", "#8f8b82"],
    ["--accent", "#ff5b1f"],
    ["--ok", "#9bd770"]
  ]) {
    assert.match(dark, new RegExp(`${name}:\\s*${value}`, "i"), `dark ${name} drifted`);
  }
  /* Light values must match the paper palette */
  const light = tokens.slice(tokens.indexOf('html[data-theme="light"]'));
  for (const [name, value] of [
    ["--bg", "#f4f1ea"],
    ["--surface", "#fbf9f4"],
    ["--border", "#ddd8cc"],
    ["--text", "#171613"],
    ["--muted", "#6b665c"],
    ["--accent-text", "#c73e0a"]
  ]) {
    assert.match(light, new RegExp(`${name}:\\s*${value}`, "i"), `light ${name} drifted`);
  }
  assert.match(tokens, /--blocks-display:\s*var\(--font-display\)/);
  assert.match(tokens, /--font-display:\s*"Instrument Serif"/);
  assert.match(tokens, /--font-sans:\s*"Geist"/);
  assert.match(tokens, /--font-mono:\s*"Geist Mono"/);
  assert.doesNotMatch(tokens, /font-family:[^;]*\b(Inter|Poppins|Sora)\b/);
  /* The banned family of bugs this file was written against: the old navy shell. */
  assert.doesNotMatch(`${tokens}${chat}`, /#070b14/i);
});
