import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  buildProviderNetwork,
  providerActivityFor,
  providerStatusFor,
  providerSummaryFor,
  resolveProviderIdentity
} from "../src/combo/comboProviders.js";
import { buildCoreLayout } from "../src/combo/comboCoreLayout.js";

function saved(provider, providerId, modelId, configId = "cfg-1") {
  return {
    key: `saved:${configId}:${modelId}`,
    kind: "saved",
    configId,
    providerId,
    provider,
    providerType: "openai_compatible",
    model: modelId,
    label: modelId
  };
}

function shared(provider, modelId) {
  return {
    key: `shared:${modelId}`,
    kind: "shared",
    configId: "",
    providerId: "",
    provider,
    providerType: "openai_compatible",
    model: modelId,
    label: modelId
  };
}

function availabilityOf(entries) {
  return new Map(Object.entries(entries));
}

test("three OpenAI models resolve to exactly one OpenAI provider node", () => {
  const network = buildProviderNetwork([
    saved("OpenAI", "openai", "gpt-4o"),
    saved("OpenAI", "openai", "gpt-5"),
    saved("OpenAI", "openai", "gpt-4.1")
  ]);
  assert.equal(network.length, 1);
  assert.equal(network[0].canonicalId, "openai");
  assert.equal(network[0].name, "OpenAI");
  assert.equal(network[0].keys.length, 3);
  assert.equal(network[0].artwork.type, "wordmark");
  assert.equal(network[0].artwork.wordmark, "OpenAI");
});

test("two Anthropic models resolve to one node and different providers stay separate", () => {
  const anthropic = buildProviderNetwork([
    saved("Anthropic", "anthropic", "claude-sonnet-4.5"),
    saved("Anthropic", "anthropic", "claude-opus-4.1")
  ]);
  assert.equal(anthropic.length, 1);
  assert.equal(anthropic[0].artwork.id, "anthropic");
  assert.equal(anthropic[0].artwork.type, "logo");

  const mixed = buildProviderNetwork([
    saved("OpenAI", "openai", "gpt-5"),
    saved("Anthropic", "anthropic", "claude-opus-4.1"),
    saved("Google Gemini API", "google-gemini", "gemini-2.5-pro")
  ]);
  assert.deepEqual(mixed.map(provider => provider.canonicalId), ["openai", "anthropic", "googlegemini"]);
  assert.equal(new Set(mixed.map(provider => provider.id)).size, 3);
});

test("same provider across two configurations merges; custom endpoints stay scoped", () => {
  const direct = buildProviderNetwork([
    saved("OpenAI", "openai", "gpt-5", "cfg-a"),
    saved("OpenAI", "openai", "gpt-4.1", "cfg-b")
  ]);
  assert.equal(direct.length, 1, "two OpenAI keys are still one provider identity");

  const custom = buildProviderNetwork([
    saved("My OpenAI proxy", "custom-openai", "gpt-5", "cfg-a"),
    saved("Other OpenAI proxy", "custom-openai", "gpt-5", "cfg-b")
  ]);
  assert.equal(custom.length, 2, "unrelated custom endpoints must not be merged");
  assert.notEqual(custom[0].id, custom[1].id);
});

test("deselecting one model keeps the provider node while another model remains", () => {
  const first = saved("OpenAI", "openai", "gpt-5");
  const second = saved("OpenAI", "openai", "gpt-4.1");
  const both = buildProviderNetwork([first, second]);
  assert.equal(both.length, 1);

  const oneLeft = buildProviderNetwork([second]);
  assert.equal(oneLeft.length, 1);
  assert.deepEqual(oneLeft[0].keys, [second.key]);

  const none = buildProviderNetwork([]);
  assert.equal(none.length, 0);
});

test("adding a provider updates the network and removing the last model removes its node", () => {
  const openai = saved("OpenAI", "openai", "gpt-5");
  const anthropic = saved("Anthropic", "anthropic", "claude-opus-4.1");
  const before = buildProviderNetwork([openai]);
  const after = buildProviderNetwork([openai, anthropic]);
  assert.deepEqual(before.map(provider => provider.id), ["provider:openai"]);
  assert.deepEqual(after.map(provider => provider.id), ["provider:openai", "provider:anthropic"]);

  const removed = buildProviderNetwork([openai]);
  assert.deepEqual(removed.map(provider => provider.id), ["provider:openai"]);
});

test("a provider is inactive only when every one of its selected models is unavailable", () => {
  const openai = saved("OpenAI", "openai", "gpt-5");
  const other = saved("OpenAI", "openai", "gpt-4.1");
  const provider = buildProviderNetwork([openai, other])[0];

  assert.equal(providerStatusFor(provider, availabilityOf({})), "unknown");
  assert.equal(
    providerStatusFor(provider, availabilityOf({ [openai.key]: { status: "not_working" } })),
    "unknown"
  );
  assert.equal(
    providerStatusFor(provider, availabilityOf({
      [openai.key]: { status: "not_working" },
      [other.key]: { status: "not_working" }
    })),
    "not_working"
  );
  assert.equal(
    providerStatusFor(provider, availabilityOf({
      [openai.key]: { status: "working" },
      [other.key]: { status: "not_working" }
    })),
    "working"
  );
});

test("provider activity aggregates only real orchestration events", () => {
  const first = saved("OpenAI", "openai", "gpt-5");
  const second = saved("OpenAI", "openai", "gpt-4.1");
  const provider = buildProviderNetwork([first, second])[0];

  assert.equal(providerActivityFor(provider, null), null);
  assert.equal(providerActivityFor(provider, new Map()), null);
  assert.equal(providerActivityFor(provider, new Map([[first.key, "queued"]])), "queued");
  assert.equal(providerActivityFor(provider, new Map([
    [first.key, "queued"],
    [second.key, "working"]
  ])), "working");
  assert.equal(providerActivityFor(provider, new Map([
    [first.key, "failed"],
    [second.key, "done"]
  ])), "done");
  assert.equal(providerActivityFor(provider, new Map([[first.key, "failed"]])), "failed");
});

test("provider summary counts every unique provider once", () => {
  const network = buildProviderNetwork([
    saved("OpenAI", "openai", "gpt-5"),
    saved("OpenAI", "openai", "gpt-4.1"),
    saved("Anthropic", "anthropic", "claude-opus-4.1")
  ]);
  const map = availabilityOf({
    [network[0].keys[0]]: { status: "working" },
    [network[0].keys[1]]: { status: "not_working" },
    [network[1].keys[0]]: { status: "not_working" }
  });
  assert.deepEqual(providerSummaryFor(network, map), {
    total: 2,
    working: 1,
    notWorking: 1,
    unknown: 0
  });
});

test("gateway-routed models collapse to their vendor identity", () => {
  const network = buildProviderNetwork([
    saved("Kilo Gateway", "kilo-gateway", "openai/gpt-5", "cfg-k"),
    saved("Kilo Gateway", "kilo-gateway", "openai/gpt-4.1", "cfg-k"),
    saved("Kilo Gateway", "kilo-gateway", "openai/gpt-4o", "cfg-k"),
    saved("Kilo Gateway", "kilo-gateway", "anthropic/claude-opus-4.1", "cfg-k"),
    saved("Kilo Gateway", "kilo-gateway", "anthropic/claude-sonnet-4.5", "cfg-k"),
    saved("Kilo Gateway", "kilo-gateway", "google/gemini-2.5-pro", "cfg-k")
  ]);
  assert.deepEqual(network.map(provider => provider.canonicalId), ["openai", "anthropic", "googlegemini"]);
  assert.equal(network.length, 3);
  assert.equal(network[0].keys.length, 3);
  assert.equal(network[1].keys.length, 2);
  assert.equal(network[2].keys.length, 1);
  assert.equal(network[0].artwork.wordmark, "OpenAI");
  assert.equal(network[1].artwork.type, "logo");
});

test("gateway-routed models without a vendor identity stay on the gateway node", () => {
  const network = buildProviderNetwork([
    saved("Kilo Gateway", "kilo-gateway", "kilo-auto/free", "cfg-k"),
    saved("Kilo Gateway", "kilo-gateway", "totally-unknown-model", "cfg-k")
  ]);
  assert.equal(network.length, 1);
  assert.equal(network[0].canonicalId, "kilo");
  assert.equal(network[0].keys.length, 2);
});

test("direct and gateway routes for the same brand share one provider node", () => {
  const network = buildProviderNetwork([
    saved("OpenAI", "openai", "gpt-5", "cfg-direct"),
    saved("Kilo Gateway", "kilo-gateway", "openai/gpt-4.1", "cfg-k")
  ]);
  assert.equal(network.length, 1);
  assert.equal(network[0].canonicalId, "openai");
  assert.equal(network[0].keys.length, 2);
});

test("shared gateway models resolve through vendor identity and Vups keeps its own node", () => {
  const network = buildProviderNetwork([
    shared("OpenRouter", "deepseek-v4:free"),
    shared("OpenRouter", "qwen3.6:free"),
    shared("Ollama", "llama-3.3-70b"),
    {
      key: "vups:vups-v3-galax",
      kind: "vups",
      configId: "",
      providerId: "",
      provider: "Vups",
      model: "vups-v3-galax",
      label: "Vups"
    }
  ]);
  assert.deepEqual(network.map(provider => provider.canonicalId), ["deepseek", "qwen", "meta", "vups"]);
  assert.equal(network[0].keys.length, 1);
});

test("model names never appear inside the animated network", () => {
  const source = readFileSync(new URL("../src/combo/ComboPowerCore.jsx", import.meta.url), "utf8");
  assert.equal(/model\.(label|model)\b/.test(source), false, "core must not render model labels or IDs");
  assert.equal(source.includes("combo-core-node__name"), false);
  assert.equal(source.includes("combo-core-node__status"), false);
  assert.equal(source.includes("provider models"), false);

  const network = buildProviderNetwork([
    saved("OpenAI", "openai", "gpt-5"),
    saved("Anthropic", "anthropic", "claude-opus-4.1")
  ]);
  for (const provider of network) {
    assert.equal("label" in provider, false);
    assert.equal("model" in provider, false);
    assert.ok(provider.name === "OpenAI" || provider.name === "Anthropic");
  }
});

test("provider logos are never duplicated in the network", () => {
  const network = buildProviderNetwork([
    saved("OpenAI", "openai", "gpt-5"),
    saved("OpenAI", "openai", "gpt-4.1"),
    saved("OpenAI", "openai", "gpt-4o"),
    saved("Anthropic", "anthropic", "claude-opus-4.1"),
    saved("Anthropic", "anthropic", "claude-sonnet-4.5")
  ]);
  const marks = network.map(provider => provider.artwork.src || `${provider.artwork.type}:${provider.artwork.wordmark}`);
  assert.equal(new Set(marks).size, marks.length);
  assert.equal(network.length, 2);
});

test("the central VupsRouter identity stays circular and larger than provider nodes", () => {
  const network = buildProviderNetwork([
    saved("OpenAI", "openai", "gpt-5"),
    saved("Anthropic", "anthropic", "claude-opus-4.1"),
    saved("Google Gemini API", "google-gemini", "gemini-2.5-pro"),
    shared("OpenRouter", "deepseek-v4:free")
  ]);
  for (const width of [960, 390]) {
    const layout = buildCoreLayout(network, { width, height: width === 960 ? 600 : 340 });
    assert.ok(layout.centerSize >= layout.nodeSize * 2.2, `center ${layout.centerSize} vs node ${layout.nodeSize}`);
    assert.ok(layout.centerSize < Math.min(layout.width, layout.height));
    assert.ok(Math.abs(layout.center.x - layout.width / 2) < 0.001);
  }
  const css = readFileSync(new URL("../src/combo/combo.css", import.meta.url), "utf8");
  const plate = css.match(/\.combo-core__plate \{([\s\S]*?)\}/);
  assert.ok(plate);
  assert.match(plate[1], /border-radius: 50%/);
  // Percentage, not pixels: the plate has to keep scaling with
  // --combo-center-size at every viewport the layout can produce.
  assert.match(plate[1], /inset: \d+(\.\d+)?%/);
});

test("mobile layouts keep every provider node and wire inside the core", () => {
  const network = Array.from({ length: 12 }, (_, index) => ({
    id: `provider:test-${index}`,
    canonicalId: `test-${index}`,
    name: `Provider ${index}`,
    artwork: { id: `test-${index}`, type: "wordmark", wordmark: `P${index}`, color: "#fff" },
    models: [],
    keys: []
  }));
  for (const [width, height] of [[390, 340], [320, 300], [768, 420]]) {
    for (const count of [1, 2, 4, 8, 12]) {
      const layout = buildCoreLayout(network.slice(0, count), { width, height });
      assert.equal(layout.count, count);
      for (const node of layout.nodes) {
        assert.equal(node.withinBounds, true);
        assert.ok(node.x - layout.nodeRadius >= 0);
        assert.ok(node.x + layout.nodeRadius <= width);
        assert.ok(node.y - layout.nodeRadius >= 0);
        assert.ok(node.y + layout.nodeRadius <= height);
        const [startX, startY, endX, endY] = node.wire
          .match(/M ([\d.]+) ([\d.]+) Q [\d.]+ [\d.]+ ([\d.]+) ([\d.]+)/)
          .slice(1)
          .map(Number);
        const startDistance = Math.hypot(startX - layout.center.x, startY - layout.center.y);
        const endDistance = Math.hypot(endX - node.x, endY - node.y);
        const span = Math.hypot(node.x - layout.center.x, node.y - layout.center.y);
        const clearance = span - layout.centerRadius - layout.nodeRadius;
        // Both tips belong inside their housings. A cable is free of the
        // artwork painted on those housings whenever there is room to draw one;
        // on a 320px phone the ring can sit 8px from the core, and there the
        // only promises that still mean something are "plugged in" and
        // "neither end reaches the middle".
        assert.ok(startDistance <= layout.centerRadius, "wire must reach the core housing");
        assert.ok(endDistance <= layout.nodeRadius, "wire must reach the provider housing");
        assert.ok(startDistance < span / 2 && endDistance < span / 2, "wire ends must not cross");
        if (clearance > 12) {
          assert.ok(startDistance >= layout.centerRadius * 0.8, "wire must not cross the central logo");
          assert.ok(endDistance >= layout.nodeRadius * 0.8, "wire must not cross the provider mark");
        }
      }
    }
  }
  const css = readFileSync(new URL("../src/combo/combo.css", import.meta.url), "utf8");
  const core = css.match(/\.combo-core \{([\s\S]*?)\}/);
  assert.ok(core);
  assert.match(core[1], /overflow: hidden/);
  const note = css.match(/\.combo-core__note \{([\s\S]*?)\}/);
  assert.ok(note);
  assert.match(
    note[1],
    /max-width: min\(250px, calc\(50% - var\(--combo-node-size\) \* 0\.5 - 30px\)\)/,
    "the note must stay left of the top node"
  );
});

test("the core never claims to measure CPU, GPU, electrical, or power data", () => {
  const source = readFileSync(new URL("../src/combo/ComboPowerCore.jsx", import.meta.url), "utf8");
  assert.match(source, /not a CPU\/GPU power measurement/);
  assert.equal(/actual (cpu|gpu|power|electric)/i.test(source), false);
});

test("activity clears when a run settles so no provider stays active", () => {
  const chatSource = readFileSync(new URL("../src/ChatPage.jsx", import.meta.url), "utf8");
  const liveSource = readFileSync(new URL("../src/combo/comboLive.js", import.meta.url), "utf8");
  // The run is driven from the chat composer now, so this guarantee moved with it:
  // the composer always closes the live run, and closing it empties the activity.
  assert.match(chatSource, /startComboRun\(\);\s*try \{/);
  assert.match(chatSource, /finally \{\s*endComboRun\(\);\s*\}/);
  const end = /export function endComboRun\(\) \{([\s\S]*?)\n\}/.exec(liveSource);
  assert.ok(end, "endComboRun is exported");
  assert.match(end[1], /state = EMPTY\(\)/, "ending a run must reset, not merely flag, the activity");
  assert.match(liveSource, /const EMPTY = \(\) => \(\{[\s\S]*?activity: new Map\(\)/);
});

test("a lost context degrades this mount without falsifying the probe", () => {
  const source = readFileSync(new URL("../src/combo/ComboPowerCore.jsx", import.meta.url), "utf8");
  const handler = /onContextLost=\{\(\) => \{([\s\S]*?)\n              \}\}/.exec(source);
  assert.ok(handler, "the machine reports a lost webgl context");
  // react-three-fiber forceContextLoss()es its own canvas while unmounting, so a
  // cached "false" here would keep every later visit to Apex in the 2D fallback.
  assert.match(handler[1], /webglProbe = null;/, "the next entry probes the real capability again");
  assert.doesNotMatch(handler[1], /webglProbe = false;/, "a teardown loss must not disable WebGL for the session");
  assert.match(handler[1], /setMachineEnabled\(false\);/, "the mount that lost its context still degrades");
});

test("GSAP effects are scoped and reverted, and reduced motion is honored", () => {
  const source = readFileSync(new URL("../src/combo/ComboPowerCore.jsx", import.meta.url), "utf8");
  assert.ok((source.match(/context\.revert\(\)/g) || []).length >= 4);
  assert.equal(source.includes("setInterval"), false);
  assert.match(source, /prefers-reduced-motion: reduce/);
  assert.match(source, /if \(reduced\)/);
  const css = readFileSync(new URL("../src/combo/combo.css", import.meta.url), "utf8");
  assert.match(css, /@media \(prefers-reduced-motion: reduce\)/);
});

test("activity keys still point at the real selected model keys", () => {
  const first = saved("OpenAI", "openai", "gpt-5");
  const second = saved("Anthropic", "anthropic", "claude-opus-4.1");
  const network = buildProviderNetwork([first, second]);
  assert.deepEqual(network.flatMap(provider => provider.keys), [first.key, second.key]);
});

test("identity resolution is deterministic and never merges unrelated unknown providers", () => {
  const first = resolveProviderIdentity(shared("Acme Gateway", "acme-1"));
  const second = resolveProviderIdentity(shared("Acme Gateway", "acme-2"));
  assert.equal(first.id, second.id);
  assert.equal(first.id, "shared:acme-gateway");

  const other = resolveProviderIdentity(shared("Other Gateway", "other-1"));
  assert.notEqual(first.id, other.id);
});
