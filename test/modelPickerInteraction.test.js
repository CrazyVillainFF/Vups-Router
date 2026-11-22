/**
 * The model picker must open when the selected model is tapped.
 *
 * The bug this replaces was not in the picker at all. The composer field
 * wrapper re-focused the prompt textarea on every click inside it, and a
 * textarea that takes focus closes every menu. So the model button opened the
 * picker and the wrapper's own click closed it again in the same breath, and
 * the list was never visible no matter how the button was pressed.
 *
 * The picker is rendered for real here, through Vite's esbuild pipeline, with
 * the props the chat page hands it — a non-empty command list, a real model
 * catalogue and a draft — because the failure only appears with those.
 */
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { after, before, afterEach, beforeEach, describe, test } from "node:test";
import { JSDOM } from "jsdom";
import { transformWithEsbuild } from "vite";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const workDir = path.join(root, "test", ".compiled-model-picker");
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
    KeyboardEvent: window.KeyboardEvent,
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

// The catalogue the chat page hands the composer.
const models = [
  { key: "vups", name: "Vups v3 Galax", model: "vups-v3-galax", vups: true, free: true, badge: "VUPS" },
  { key: "combo", name: "Vups Combo AI", model: "vups-combo-apex", combo: true, badge: "APEX" },
  {
    key: "saved:gemini:gemini-2.5-pro",
    name: "Gemini 2.5 Pro",
    model: "gemini-2.5-pro",
    provider: "Google Gemini",
    configId: "cfg_gemini",
    saved: true
  }
];

// The chat page hands the composer its slash commands, which is what makes the
// composer parse the draft for a "/" or "@" token.
const commands = [{ name: "/help", description: "Show help" }];

describe("the model picker opens when the selected model is pressed", () => {
  let PromptBar;
  let React;
  let ReactDOMClient;
  let dom;
  let trees = [];
  let changes = [];

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
    changes = [];
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
          commands,
          defaultModel: "vups",
          onModelChange: row => changes.push(row),
          onSend: () => {},
          ...props
        })
      );
    });
    return dom.container;
  }

  /** A real press: mousedown, then mouseup, then click, all bubbling. */
  function press(element) {
    React.act(() => {
      element.dispatchEvent(new dom.window.MouseEvent("mousedown", { bubbles: true, cancelable: true }));
      element.dispatchEvent(new dom.window.MouseEvent("mouseup", { bubbles: true, cancelable: true }));
      element.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true, cancelable: true }));
    });
  }

  const modelButton = container => container.querySelector(".prompt-bar__pick--model");
  const modelMenu = container => container.querySelector(".prompt-bar__menu[data-kind='model']");
  const rowNames = container =>
    [...container.querySelectorAll(".prompt-bar__row--model")].map(row => row.querySelector(".prompt-bar__row-name")?.textContent);

  test("pressing the selected model opens the model list", () => {
    const container = render();
    assert.equal(modelMenu(container), null, "the picker starts closed");
    press(modelButton(container));
    assert.ok(modelMenu(container), "the picker must open");
    assert.equal(modelButton(container).getAttribute("aria-expanded"), "true");
  });

  test("the picker lists the configured models, not a hardcoded set", () => {
    const container = render();
    press(modelButton(container));
    assert.deepEqual(rowNames(container), ["Vups v3 Galax", "Vups Combo AI", "Gemini 2.5 Pro"]);
  });

  test("the picker still opens while the prompt textarea holds the focus", () => {
    const container = render();
    const input = container.querySelector(".prompt-bar__input");
    React.act(() => { input.focus(); });
    assert.equal(dom.window.document.activeElement, input);
    press(modelButton(container));
    assert.ok(modelMenu(container), "a focused textarea must not stop the picker opening");
  });

  test("opening the picker does not put the caret back into the prompt", () => {
    // The prompt taking focus is what closes every menu, so a press on the
    // model button must leave the prompt untouched. This is also what keeps
    // the Android keyboard from rising over the list.
    const container = render();
    const input = container.querySelector(".prompt-bar__input");
    let promptFocused = false;
    input.addEventListener("focus", () => { promptFocused = true; });
    press(modelButton(container));
    assert.ok(modelMenu(container));
    assert.equal(promptFocused, false, "the prompt must not take focus while the picker is open");
  });

  test("a draft that ends in a slash token does not hide the model list", () => {
    const container = render({ draftValue: "hello /", draftSignal: 1 });
    press(modelButton(container));
    const menu = modelMenu(container);
    assert.ok(menu, "the model list wins over the slash menu");
    assert.equal(menu.getAttribute("data-kind"), "model");
  });

  test("selecting a model reports the exact provider configuration", () => {
    const container = render();
    press(modelButton(container));
    const row = [...container.querySelectorAll(".prompt-bar__row--model")]
      .find(entry => /Gemini 2\.5 Pro/.test(entry.textContent || ""));
    press(row);
    assert.equal(changes.length, 1, "exactly one selection");
    assert.equal(changes[0].key, "saved:gemini:gemini-2.5-pro");
    assert.equal(changes[0].model, "gemini-2.5-pro");
    assert.equal(changes[0].configId, "cfg_gemini", "the provider configuration is carried, not guessed");
    assert.equal(changes[0].provider, "Google Gemini");
    assert.equal(modelMenu(container), null, "the picker closes after a selection");
  });

  test("the selected model is shown on the control and checked in the list", () => {
    const container = render();
    press(modelButton(container));
    const row = [...container.querySelectorAll(".prompt-bar__row--model")]
      .find(entry => /Gemini 2\.5 Pro/.test(entry.textContent || ""));
    press(row);
    assert.match(modelButton(container).textContent || "", /Gemini 2\.5 Pro/);
    press(modelButton(container));
    const checked = [...container.querySelectorAll(".prompt-bar__row--model")]
      .filter(entry => entry.querySelector(".prompt-bar__row-check[data-on]"));
    assert.equal(checked.length, 1, "one row is checked");
    assert.match(checked[0].textContent || "", /Gemini 2\.5 Pro/);
  });

  test("the draft survives opening and choosing from the picker", () => {
    const container = render({ draftValue: "keep this draft", draftSignal: 1 });
    press(modelButton(container));
    const row = [...container.querySelectorAll(".prompt-bar__row--model")]
      .find(entry => /Gemini 2\.5 Pro/.test(entry.textContent || ""));
    press(row);
    assert.equal(container.querySelector(".prompt-bar__input").value, "keep this draft");
  });

  test("on Android the list does not raise the keyboard over itself", () => {
    // The native Android shell raises the soft keyboard for the search field,
    // which would cover the list it is meant to search. There the list stays
    // unfocused and the keyboard is left down.
    const container = render({ showCamera: true });
    press(modelButton(container));
    assert.ok(modelMenu(container));
    const search = container.querySelector(".prompt-bar__model-search");
    assert.ok(search, "the list has a search field");
    assert.notEqual(
      dom.window.document.activeElement,
      search,
      "the search field must not take the keyboard on Android"
    );
  });

  test("on a desktop the search field takes the typing", () => {
    const container = render();
    press(modelButton(container));
    assert.ok(modelMenu(container));
    const search = container.querySelector(".prompt-bar__model-search");
    assert.equal(
      dom.window.document.activeElement,
      search,
      "the search field is where typing belongs once the prompt is out of the way"
    );
  });

  test("the picker opens and closes again and again", () => {
    const container = render();
    for (let i = 0; i < 4; i++) {
      press(modelButton(container));
      assert.ok(modelMenu(container), `open attempt ${i + 1}`);
      press(modelButton(container));
      assert.equal(modelMenu(container), null, `close attempt ${i + 1}`);
    }
  });

  test("a press outside the composer closes the picker", () => {
    const container = render();
    press(modelButton(container));
    assert.ok(modelMenu(container));
    React.act(() => {
      dom.window.document.body.dispatchEvent(
        new dom.window.MouseEvent("pointerdown", { bubbles: true, cancelable: true })
      );
    });
    assert.equal(modelMenu(container), null);
  });
});

// ─── the wiring that caused it ───────────────────────────────────────────────

test("the composer field cannot close the picker it just opened", () => {
  const bar = read("src/components/reactbits/PromptBar.jsx");
  // The field wrapper focuses the prompt on any click inside it. A prompt
  // that takes focus closes every menu, so the model button's own press has
  // to stop before it reaches that wrapper.
  assert.match(bar, /onClick=\{focusInput\}/, "the field still focuses the prompt on a bare click");
  const handler = /const openModelMenu = event => \{([\s\S]*?)\n  \};/.exec(bar);
  assert.ok(handler, "the model button has its own handler");
  const body = handler[1].replace(/\/\/[^\n]*/g, "");
  assert.match(
    body,
    /stopPropagation\?\.\(\)|stopPropagation\(\)/,
    "the model press must not reach the field wrapper that closes the menu"
  );
});

test("the model menu outranks a slash or mention token in the draft", () => {
  const bar = read("src/components/reactbits/PromptBar.jsx");
  assert.match(
    bar,
    /modelOpen \? 'model' : \(token\?\.kind/,
    "the model list is chosen before a slash or mention token"
  );
});

test("the prompt is blurred while the picker is open, so the keyboard cannot cover it", () => {
  const bar = read("src/components/reactbits/PromptBar.jsx");
  const handler = /const openModelMenu = event => \{([\s\S]*?)\n  \};/.exec(bar);
  assert.match(handler[1].replace(/\/\/[^\n]*/g, ""), /dismissKeyboard\(\)/);
  assert.match(bar, /modelSearchRef\.current\?\.focus/, "the search field takes the typing on desktop");
});

test("the chosen row is what the next message is sent with", () => {
  const bar = read("src/components/reactbits/PromptBar.jsx");
  // The composer sends the row it is showing, so the request carries that
  // row's own configuration rather than a name that could belong to another
  // provider's model of the same name.
  assert.match(bar, /onSend\?\.\(draft\.trim\(\), \{ attachments: outgoing, model, effort: level \}\)/);
  assert.match(bar, /setModelKey\(row\.key\)/, "picking a row moves the composer's own selection");
  const page = read("src/ChatPage.jsx");
  assert.match(
    page,
    /catalog\.find\(\(row\) => row\.key === meta\?\.model\?\.key\) \|\| meta\?\.model \|\| activeRow/,
    "the chat page resolves the sent row by its key, not by its name"
  );
  assert.match(page, /const reference = chatReference\(selectedRow\)/);
});

test("a saved model keeps its own configuration instead of being resolved by name", () => {
  const catalog = read("src/chat/modelCatalog.js");
  assert.match(
    catalog,
    /return \{ model: row\.model, configId: row\.configId \|\| undefined, providerId: row\.providerId \|\| undefined \}/,
    "the request carries the provider configuration of the chosen row"
  );
  assert.match(
    catalog,
    /export function selectionFromRow[\s\S]*?return \{ kind: "saved", configId: row\.configId \|\| "", model: row\.model \}/,
    "the stored selection keeps the configuration id"
  );
});
