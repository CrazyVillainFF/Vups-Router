/**
 * The chat must not brand the assistant's answer with a logo in a box.
 *
 * The composer chip is the only place in the chat that used to render the app
 * mark beside the selected model, and it framed that mark in an orange border.
 * The assistant response itself never had an avatar, and the sidebar's brand
 * mark is deliberate branding that has to stay.
 *
 * The composer is rendered for real here, with Vups Combo AI selected, so the
 * assertion is about the DOM the user sees rather than about the source.
 */
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { after, before, afterEach, beforeEach, describe, test } from "node:test";
import { JSDOM } from "jsdom";
import { transformWithEsbuild } from "vite";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const workDir = path.join(root, "test", ".compiled-combo-branding");
const read = relative => readFileSync(path.join(root, relative), "utf8");

const compiledBySource = new Map();

function resolveDependency(fromFile, spec) {
  const base = path.resolve(path.dirname(fromFile), spec);
  const candidates = [base, `${base}.jsx`, `${base}.js`, path.join(base, "index.jsx"), path.join(base, "index.js")];
  const found = candidates.find(candidate => existsSync(candidate) && statSync(candidate).isFile());
  if (!found) throw new Error(`Cannot resolve ${spec} from ${fromFile}`);
  return found;
}

async function compileModule(absolute) {
  const existing = compiledBySource.get(absolute);
  if (existing) return existing;
  const out = path.join(workDir, `module${compiledBySource.size}.mjs`);
  compiledBySource.set(absolute, out);
  let source = readFileSync(absolute, "utf8").replace(/^\s*import\s+["'][^"']+\.css["'];?\s*$/gm, "");
  const dependencies = [];
  source = source.replace(/(\bfrom\s+|\bimport\s+)["'](\.[^"']+)["']/g, (_match, keyword, spec) => {
    dependencies.push(resolveDependency(absolute, spec));
    return `${keyword}"__dep${dependencies.length - 1}__"`;
  });
  for (const [index, dependency] of dependencies.entries()) {
    const compiled = await compileModule(dependency);
    const specifier = `./${path.relative(workDir, compiled).replace(/\\/g, "/")}`;
    source = source.replace(`"__dep${index}__"`, `"${specifier}"`);
  }
  const { code } = await transformWithEsbuild(source, absolute, { loader: "jsx", jsx: "automatic" });
  writeFileSync(out, code);
  return out;
}

async function loadModule(sourcePath) {
  const file = await compileModule(path.join(root, sourcePath));
  return import(pathToFileURL(file).href);
}

const savedDescriptors = new Map();

function restoreGlobals() {
  for (const [key, descriptor] of savedDescriptors) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else delete globalThis[key];
  }
  savedDescriptors.clear();
}

function installDom() {
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', { url: "https://vups.test/" });
  const { window } = dom;
  window.matchMedia = query => ({
    media: query,
    matches: false,
    addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}
  });
  const globals = {
    window,
    document: window.document,
    navigator: window.navigator,
    self: window,
    HTMLElement: window.HTMLElement,
    Element: window.Element,
    Node: window.Node,
    Event: window.Event,
    MouseEvent: window.MouseEvent,
    getComputedStyle: window.getComputedStyle.bind(window),
    requestAnimationFrame: callback => setTimeout(() => callback(Date.now()), 0),
    cancelAnimationFrame: id => clearTimeout(id),
    IS_REACT_ACT_ENVIRONMENT: true
  };
  for (const [key, value] of Object.entries(globals)) {
    if (!savedDescriptors.has(key)) {
      savedDescriptors.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    }
    Object.defineProperty(globalThis, key, { value, writable: true, configurable: true });
  }
  return { window, container: window.document.getElementById("root") };
}

// The catalogue the chat page hands the composer, with Combo AI selected.
const models = [
  { key: "combo", name: "Vups Combo AI", model: "vups-combo-apex", combo: true, badge: "APEX", tag: "Apex coordinator" },
  { key: "vups", name: "Vups v3 Galax", model: "vups-v3-galax", vups: true, free: true, badge: "VUPS" }
];

describe("the composer names the model instead of branding it", () => {
  let PromptBar;
  let React;
  let ReactDOMClient;
  let dom;
  let trees = [];

  before(async () => {
    mkdirSync(workDir, { recursive: true });
    PromptBar = (await loadModule("src/components/reactbits/PromptBar.jsx")).default;
    React = await import("react");
    ReactDOMClient = await import("react-dom/client");
  });

  after(async () => {
    await new Promise(resolve => { setTimeout(resolve, 50); });
    restoreGlobals();
    rmSync(workDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });

  beforeEach(() => {
    dom = installDom();
    trees = [];
  });

  afterEach(async () => {
    await React.act(async () => {
      for (const entry of trees) {
        if (entry.disposed) continue;
        entry.disposed = true;
        entry.root.unmount();
      }
    });
    trees = [];
  });

  function render(props = {}) {
    const handle = ReactDOMClient.createRoot(dom.container);
    const entry = { root: handle, disposed: false };
    trees.push(entry);
    React.act(() => {
      handle.render(
        React.createElement(PromptBar, {
          models,
          defaultModel: "combo",
          onModelChange: () => {},
          onSend: () => {},
          ...props
        })
      );
    });
    return dom.container;
  }

  test("the selected Combo model renders no logo", () => {
    const container = render();
    const chip = container.querySelector(".prompt-bar__pick--model");
    assert.ok(chip, "the model control is there");
    assert.match(chip.textContent || "", /Vups Combo AI/, "the model name is readable");
    assert.equal(chip.querySelectorAll("img").length, 0, "no logo sits beside the model name");
    assert.equal(container.querySelector(".prompt-bar__pick-mark"), null, "the mark slot is gone");
    assert.equal(container.querySelectorAll("img").length, 0, "the composer renders no image at all");
  });

  test("the model name stays the only identity on the control", () => {
    const container = render();
    const chip = container.querySelector(".prompt-bar__pick--model");
    assert.match(chip.getAttribute("aria-label") || "", /Vups Combo AI/);
    assert.match(chip.getAttribute("title") || "", /Vups Combo AI/);
    assert.equal(chip.querySelectorAll("span").length, 1, "only the name span remains");
  });

  test("the picker still opens from the model control", () => {
    const container = render();
    const chip = container.querySelector(".prompt-bar__pick--model");
    React.act(() => {
      chip.dispatchEvent(new dom.window.MouseEvent("mousedown", { bubbles: true, cancelable: true }));
      chip.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true, cancelable: true }));
    });
    assert.ok(container.querySelector(".prompt-bar__menu[data-kind='model']"), "the picker opens");
    assert.deepEqual(
      [...container.querySelectorAll(".prompt-bar__row--model .prompt-bar__row-name")].map(r => r.textContent),
      ["Vups Combo AI", "Vups v3 Galax"],
      "Combo AI is still in the list"
    );
  });
});

// ─── the assistant response ─────────────────────────────────────────────────

test("the assistant response carries no logo and no avatar", () => {
  const page = read("src/ChatPage.jsx");
  assert.ok(!/vr-msg-avatar/.test(page), "the assistant message has no avatar slot");
  assert.ok(!/VupsLogo/.test(page), "the chat page does not render the app mark at all");
  const css = read("src/chat.css");
  assert.ok(!/vr-msg-avatar/.test(css), "the avatar styles are gone with the element");

  // The response still opens straight into its body: the avatar was a sibling
  // of the body, and removing it must not have disturbed the layout.
  const message = /<div className=\{`vr-msg \$\{isUser[\s\S]*?\}>\s*<div className="vr-msg-body"/.exec(page);
  assert.ok(message, "the assistant message renders its body directly");
  assert.ok(
    !/vr-msg-avatar/.test(page.slice(page.indexOf("vr-msg--assistant"), page.indexOf("vr-msg--assistant") + 400)),
    "no avatar is rendered beside the assistant body"
  );
});

// ─── the branding that must stay ────────────────────────────────────────────

test("the sidebar brand mark is untouched", () => {
  const sidebar = read("src/desktop/DesktopSidebar.jsx");
  assert.match(sidebar, /import VupsLogo from "\.\.\/components\/VupsLogo\.jsx"/);
  assert.match(sidebar, /className="vr-brand-mark"[^>]*><VupsLogo \/>/);
});

test("the shared logo component still serves the other brand places", () => {
  for (const file of [
    "src/desktop/DesktopSidebar.jsx",
    "src/components/SiteHeader.jsx",
    "src/components/SiteFooter.jsx",
    "src/App.jsx",
    "src/pages/LandingPage.jsx"
  ]) {
    assert.match(read(file), /VupsLogo/, `${file} still uses the shared mark`);
  }
});

test("Combo AI is still a model the user can pick", () => {
  const catalog = read("src/chat/modelCatalog.js");
  assert.match(catalog, /export const COMBO_MODEL_ID = "vups-combo-apex"/);
  assert.match(catalog, /function comboRow\(state\)/);
  assert.match(catalog, /if \(row\.combo\) return \{ model: COMBO_MODEL_ID, combo: true \}/);
});
