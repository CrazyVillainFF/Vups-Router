/**
 * Sending an image must not raise a ReferenceError.
 *
 * The composer resets the folder cards after a send is refused. That reset
 * needs the ids of the folders in the selection, and those ids were only
 * declared when the selection actually held a folder - so attaching an image
 * and sending it, with no folder in the selection, read a variable that was
 * never declared. The read happened inside a state updater, so it threw
 * during the render that followed and took the whole chat screen with it.
 *
 * These tests render the composer for real and send an image with and without
 * a folder.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { after, before, afterEach, beforeEach, describe, test as nodeTest } from "node:test";
import { JSDOM } from "jsdom";
import { transformWithEsbuild } from "vite";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const workDir = path.join(root, "test", ".compiled-folder-ids");
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

const IMAGE = {
  id: "img-1",
  kind: "image",
  type: "image/jpeg",
  size: 2048,
  name: "photo.jpg",
  mimeType: "image/jpeg",
  dataUrl: "data:image/jpeg;base64,QUJDRA==",
  thumbUrl: "data:image/jpeg;base64,QUJDRA==",
  status: "ready"
};

const FOLDER = {
  id: "folder-1",
  kind: "folder",
  type: "text/folder",
  name: "project",
  path: "C:/project",
  status: "ready"
};

describe("sending an image", () => {
  let PromptBar;
  let React;
  let ReactDOMClient;
  let dom;
  let trees = [];
  let renderErrors = [];

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
    renderErrors = [];
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
          models: [{ key: "vups", name: "Vups v3 Galax", model: "vups" }],
          defaultModel: "vups",
          onSend: () => {},
          onAttach: items => ({ items }),
          ...props
        })
      );
    });
    return dom.container;
  }

  function attach(container, items) {
    // The composer's file input is the real path an attachment takes.
    const input = container.querySelector(".prompt-bar__file");
    assert.ok(input, "the composer has a file input");
    const transfer = {
      files: items,
      items: items.map((item, index) => ({ kind: "file", getAsFile: () => item })),
      length: items.length
    };
    Object.defineProperty(input, "files", { configurable: true, value: items });
    React.act(() => {
      input.dispatchEvent(new dom.window.Event("change", { bubbles: true }));
    });
    return container;
  }

  test("an image can be sent with no folder in the selection", async () => {
    const sent = [];
    const container = render({
      onSend: (text, meta) => sent.push({ text, meta })
    });
    attach(container, [IMAGE]);
    await React.act(async () => { await new Promise(resolve => setTimeout(resolve, 10)); });

    const send = container.querySelector(".prompt-bar__send");
    assert.equal(send.disabled, false, "the image alone is enough to send");
    await React.act(async () => {
      send.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));
      await new Promise(resolve => setTimeout(resolve, 20));
    });

    assert.equal(sent.length, 1, "the message was sent once");
    assert.equal(sent[0].meta.attachments.length, 1, "the image went with it");
    assert.equal(sent[0].meta.attachments[0].kind, "image");
    assert.equal(sent[0].meta.attachments[0].dataUrl, IMAGE.dataUrl, "the picture is sent intact");
  });

  test("a refused send with an image does not raise a ReferenceError", async () => {
    // The refusal path is where the folder ids were read from a scope that
    // only existed when a folder was attached.
    const container = render({ beforeSend: () => false });
    attach(container, [IMAGE]);
    await React.act(async () => { await new Promise(resolve => setTimeout(resolve, 10)); });

    const send = container.querySelector(".prompt-bar__send");
    let failure = null;
    await React.act(async () => {
      try {
        send.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));
        await new Promise(resolve => setTimeout(resolve, 20));
      } catch (error) {
        failure = error;
      }
    });
    assert.equal(failure, null, `the send raised ${failure?.message || ""}`);
    assert.ok(
      !/folderIds is not defined/.test(String(failure?.message || "")),
      "the composer never reads a variable that was not declared"
    );
  });

  test("a refused send with a folder and an image does not raise a ReferenceError", async () => {
    const container = render({ beforeSend: () => false });
    attach(container, [FOLDER, IMAGE]);
    await React.act(async () => { await new Promise(resolve => setTimeout(resolve, 10)); });

    const send = container.querySelector(".prompt-bar__send");
    let failure = null;
    await React.act(async () => {
      try {
        send.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));
        await new Promise(resolve => setTimeout(resolve, 20));
      } catch (error) {
        failure = error;
      }
    });
    assert.equal(failure, null, `the send raised ${failure?.message || ""}`);
  });

  test("the composer declares the folder ids for the whole send", () => {
    const bar = read("src/components/reactbits/PromptBar.jsx");
    const send = bar.slice(bar.indexOf("const send = async () => {"), bar.indexOf("const toggleListen = () => {"));
    const declared = send.indexOf("const folderIds =");
    const used = send.indexOf("folderIds.includes");
    assert.ok(declared >= 0, "the folder ids are declared");
    assert.ok(declared < used, "and they are declared before they are used");
    // The declaration must sit outside the folder-only branch, or an image with
    // no folder reads a variable that was never declared.
    const folderBranch = send.indexOf("if (folders.length > 0) {");
    assert.ok(declared < folderBranch, "the folder ids are declared for every send, not only for a folder");
  });
});
