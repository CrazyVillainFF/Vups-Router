import test from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";

/* The label cache is refcounted, and the constellation reads `width`/`height`
   off whatever comes back. A cache hit that returns anything other than the
   cached entry itself throws inside the scene's useMemo, and an error raised in
   the canvas subtree takes the whole document with it — which is how the home
   page ended up blank on a second mount. These cases pin the two rules the
   scene depends on: a hit returns the same live entry, and the last release is
   the one that disposes. */

const dom = new JSDOM("<!doctype html><html><body></body></html>");

/* jsdom ships no 2D canvas backend, so the painter gets the single measurement
   call it uses plus inert no-ops for the rest. */
dom.window.HTMLCanvasElement.prototype.getContext = function getContext(kind) {
  if (kind !== "2d") return null;
  return {
    font: "",
    textBaseline: "",
    fillStyle: "",
    clearRect() {},
    fillText() {},
    measureText: () => ({ width: 120 })
  };
};

globalThis.document = dom.window.document;
globalThis.window = dom.window;

const { labelTexture, releaseLabel, cachedLabelCount, disposeLabels } =
  await import("../src/landing/dimension/labelTexture.js");

test("a cache hit returns the live entry, not a detached field of it", () => {
  disposeLabels();
  const first = labelTexture("OpenRouter", "dark");
  const second = labelTexture("OpenRouter", "dark");

  assert.equal(second, first, "the same name and theme must hand back the same entry");
  assert.equal(typeof first.width, "number");
  assert.equal(typeof first.height, "number");
  assert.ok(first.width > 0 && first.height > 0);
  assert.equal(first.refs, 2);
  assert.ok(first.texture, "the entry carries the texture the mesh samples");
  assert.equal(cachedLabelCount(), 1, "one label, not one per request");
  disposeLabels();
});

test("the label is only released when the last user of it lets go", () => {
  disposeLabels();
  const entry = labelTexture("Groq", "dark");
  labelTexture("Groq", "dark");
  let disposed = 0;
  const realDispose = entry.texture.dispose.bind(entry.texture);
  entry.texture.dispose = () => {
    disposed += 1;
    realDispose();
  };

  releaseLabel("Groq", "dark");
  assert.equal(disposed, 0, "one of two references is not the end of the texture");
  assert.equal(cachedLabelCount(), 1);

  releaseLabel("Groq", "dark");
  assert.equal(disposed, 1);
  assert.equal(cachedLabelCount(), 0);
});

test("dark and light labels stay separate entries", () => {
  disposeLabels();
  const dark = labelTexture("Gemini", "dark");
  const light = labelTexture("Gemini", "light");

  assert.notEqual(dark, light, "a label built for one palette must not serve the other");
  assert.equal(dark.refs, 1);
  assert.equal(light.refs, 1);
  assert.equal(cachedLabelCount(), 2);
  disposeLabels();
});
