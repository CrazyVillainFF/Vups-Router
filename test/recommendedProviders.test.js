import assert from "node:assert/strict";
import { mkdirSync, readFileSync, rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { after, before, test } from "node:test";
import { JSDOM } from "jsdom";
import { build } from "esbuild";
import { PROVIDERS, providerById } from "../src/providers/registry.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outDir = path.join(root, "test", ".compiled-recommended");
const read = file => readFileSync(path.join(root, file), "utf8");

const RECOMMENDED_IDS = ["ollama", "qoder", "openrouter"];

test("only Ollama, Qoder, and OpenRouter carry the recommended flag", () => {
  const flagged = PROVIDERS.filter(entry => entry.recommended === true).map(entry => entry.id).sort();
  assert.deepEqual(flagged, [...RECOMMENDED_IDS].sort());
  for (const entry of PROVIDERS) {
    if (RECOMMENDED_IDS.includes(entry.id)) continue;
    assert.ok(!entry.recommended, `${entry.id} must not be marked recommended`);
  }
});

test("each recommended provider explains why in plain language", () => {
  for (const id of RECOMMENDED_IDS) {
    const entry = providerById(id);
    assert.ok(entry, `${id} entry missing`);
    assert.equal(typeof entry.recommendation, "string", `${id} needs a recommendation line`);
    assert.ok(entry.recommendation.length > 20, `${id} recommendation is too short`);
    assert.doesNotMatch(
      entry.recommendation,
      /\bfree\b|guarantee|always works|the best\b/i,
      `${id} must not promise free access or guaranteed success`
    );
  }
});

test("both provider rows render the shared badge from registry metadata", () => {
  const page = read("src/SettingsPage.jsx");
  assert.match(page, /import \{ RecommendedBadge \} from "\.\/settings\/RecommendedBadge\.jsx"/);
  assert.match(page, /const registryEntry = registryEntryForSavedProvider\(provider\)/);
  assert.match(page, /<RecommendedBadge show=\{Boolean\(registryEntry\?\.recommended\)\} \/>/);
  assert.match(page, /<RecommendedBadge show=\{Boolean\(entry\.recommended\)\} \/>/);
  assert.match(page, /\{entry\.recommended && entry\.recommendation &&/);
});

test("saved configs resolve to registry metadata even when their providerId is name-derived", () => {
  const page = read("src/SettingsPage.jsx");
  assert.match(page, /function registryEntryForSavedProvider\(provider\)/);
  assert.match(page, /providerById\(provider\.providerId\)/);
  assert.match(page, /entry\.name\.toLowerCase\(\) === name/);
  // The saved Qoder card keeps the badge because the stored id is the slug, not "qoder".
  const qoder = providerById("qoder");
  assert.equal(qoder.recommended, true);
  assert.ok(qoder.aliases.map(alias => alias.toLowerCase()).includes("qoder"));
});

test("the badge never wraps or shrinks and uses the theme accent tokens", () => {
  const css = read("src/settings.css");
  const rule = css.match(/\.settings-badge--recommended\s*\{([^}]*)\}/);
  assert.ok(rule, "recommended badge rule is missing");
  assert.match(rule[1], /flex:\s*none/);
  assert.match(rule[1], /white-space:\s*nowrap/);
  assert.match(rule[1], /color:\s*var\(--accent\)/);
  assert.match(rule[1], /border-color:\s*var\(--accent-line\)/);
  assert.match(rule[1], /background:\s*var\(--accent-soft\)/);
  assert.match(css, /\.settings-provider-name\s*\{[^}]*flex-wrap:\s*wrap/s);
});

let dom;
let React;
let ReactDOMClient;
let RecommendedBadge;
let RECOMMENDATION_HINT;
const mounted = [];

before(async () => {
  mkdirSync(outDir, { recursive: true });
  await build({
    entryPoints: [path.join(root, "src", "settings", "RecommendedBadge.jsx")],
    outfile: path.join(outDir, "RecommendedBadge.mjs"),
    bundle: true,
    format: "esm",
    jsx: "automatic",
    external: ["react", "react/jsx-runtime"],
    logLevel: "silent"
  });

  dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "https://vups.test/" });
  const globals = {
    window: dom.window,
    document: dom.window.document,
    navigator: dom.window.navigator,
    HTMLElement: dom.window.HTMLElement,
    Element: dom.window.Element,
    Node: dom.window.Node,
    IS_REACT_ACT_ENVIRONMENT: true
  };
  for (const [key, value] of Object.entries(globals)) {
    Object.defineProperty(globalThis, key, { value, writable: true, configurable: true });
  }
  React = await import("react");
  ReactDOMClient = await import("react-dom/client");
  const module = await import(pathToFileURL(path.join(outDir, "RecommendedBadge.mjs")).href);
  RecommendedBadge = module.RecommendedBadge;
  RECOMMENDATION_HINT = module.RECOMMENDATION_HINT;
});

after(() => {
  React.act(() => {
    for (const entry of mounted.splice(0)) {
      entry.root.unmount();
      entry.container.remove();
    }
  });
  rmSync(outDir, { recursive: true, force: true });
});

function render(element) {
  const container = dom.window.document.createElement("div");
  dom.window.document.body.appendChild(container);
  const rootHandle = ReactDOMClient.createRoot(container);
  mounted.push({ root: rootHandle, container });
  React.act(() => { rootHandle.render(element); });
  return container;
}

test("the badge renders as text with the tooltip that lists the caveat", () => {
  const container = render(React.createElement(RecommendedBadge, { show: true }));
  const badge = container.querySelector(".settings-badge--recommended");
  assert.ok(badge, "recommended badge did not render");
  assert.equal(badge.textContent.trim(), "Recommended");
  assert.match(RECOMMENDATION_HINT, /not the only|other providers/i);
  assert.equal(badge.getAttribute("aria-label"), RECOMMENDATION_HINT);
  assert.equal(badge.getAttribute("title"), RECOMMENDATION_HINT);
});

test("the badge renders nothing for providers that are not recommended", () => {
  const container = render(React.createElement(RecommendedBadge, {}));
  assert.equal(container.querySelector(".settings-badge"), null);
  assert.equal(container.textContent.trim(), "");
});
