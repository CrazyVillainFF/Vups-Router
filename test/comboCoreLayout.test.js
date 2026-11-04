import test from "node:test";
import assert from "node:assert/strict";
import { buildCoreLayout, coreDensity, coreIntensity, wireAnchorRadii, wireDots } from "../src/combo/comboCoreLayout.js";

function providers(count) {
  return Array.from({ length: count }, (_, index) => ({
    id: `provider:test-${index}`,
    canonicalId: `test-${index}`,
    name: `Provider ${index}`,
    artwork: { id: `test-${index}`, type: "wordmark", wordmark: `P${index}`, color: "#fff" },
    models: [],
    keys: []
  }));
}

test("density thresholds follow the number of unique providers", () => {
  assert.equal(coreDensity(0), "comfortable");
  assert.equal(coreDensity(8), "comfortable");
  assert.equal(coreDensity(9), "compact");
  assert.equal(coreDensity(14), "compact");
  assert.equal(coreDensity(15), "dense");
  assert.equal(coreDensity(32), "dense");
});

test("core intensity reflects the working provider share, not measured power", () => {
  assert.equal(coreIntensity(0, 0), 0);
  assert.equal(coreIntensity(3, 4), 0.75);
  assert.equal(coreIntensity(4, 4), 1);
  assert.equal(coreIntensity(1, 32), 0.18);
});

test("layout uses one ring up to twelve providers and two rings beyond", () => {
  const small = buildCoreLayout(providers(12), { width: 960, height: 600 });
  assert.equal(small.count, 12);
  assert.equal(small.nodes.every(node => node.ring === 0), true);

  const large = buildCoreLayout(providers(16), { width: 960, height: 600 });
  assert.equal(large.count, 16);
  assert.equal(large.nodes.some(node => node.ring === 0), true);
  assert.equal(large.nodes.some(node => node.ring === 1), true);
});

test("every provider node stays inside the core at desktop and phone widths", () => {
  for (const [width, height] of [[960, 600], [640, 480], [390, 340], [320, 300]]) {
    for (const count of [1, 4, 10, 16, 32]) {
      const layout = buildCoreLayout(providers(count), { width, height });
      assert.equal(layout.count, count);
      assert.equal(layout.width, width);
      for (const node of layout.nodes) {
        assert.equal(node.withinBounds, true, `${count} providers at ${width}px: ${node.key} outside bounds`);
        assert.ok(node.xPct >= 0 && node.xPct <= 100);
        assert.ok(node.yPct >= 0 && node.yPct <= 100);
        assert.ok(node.wire.startsWith("M "));
      }
      assert.equal(new Set(layout.nodes.map(node => node.key)).size, count);
    }
  }
});

test("the circular center stays prominent and fully inside the card", () => {
  for (const [width, height] of [[960, 600], [768, 480], [390, 340], [320, 300]]) {
    for (const count of [1, 4, 12, 32]) {
      const layout = buildCoreLayout(providers(count), { width, height });
      assert.ok(layout.centerSize >= layout.nodeSize * 2.2, `${width}px/${count}: center too small`);
      assert.ok(layout.centerSize <= Math.min(width, height));
      assert.ok(layout.center.x - layout.centerRadius >= 0);
      assert.ok(layout.center.x + layout.centerRadius <= width);
      assert.ok(layout.center.y - layout.centerRadius >= 0);
      assert.ok(layout.center.y + layout.centerRadius <= height);
    }
  }
});

test("narrow layouts use smaller nodes than desktop layouts", () => {
  const wide = buildCoreLayout(providers(12), { width: 960, height: 600 });
  const narrow = buildCoreLayout(providers(12), { width: 320, height: 300 });
  assert.ok(narrow.nodeSize < wide.nodeSize);
  assert.ok(narrow.centerSize < wide.centerSize);
});

test("wires plug into both housings without reaching either logo", () => {
  for (const count of [1, 4, 8, 16, 32]) {
    const layout = buildCoreLayout(providers(count), { width: 390, height: 340 });
    for (const node of layout.nodes) {
      const match = node.wire.match(/M ([\d.]+) ([\d.]+) Q [\d.]+ [\d.]+ ([\d.]+) ([\d.]+)/);
      assert.ok(match, node.wire);
      const [startX, startY, endX, endY] = match.slice(1).map(Number);
      const startDistance = Math.hypot(startX - layout.center.x, startY - layout.center.y);
      const endDistance = Math.hypot(endX - node.x, endY - node.y);
      // A tip that stops outside the rim leaves a gap the eye reads as a
      // unplugged cable, so the anchor has to fall inside the silhouette while
      // still clearing the artwork (central logo 46% of the core radius, the
      // provider mark 60% of the node width including its corners).
      assert.ok(startDistance <= layout.centerRadius, "wire must reach the core housing");
      assert.ok(startDistance >= layout.centerRadius * 0.8, "wire must not cross the central logo");
      assert.ok(endDistance <= layout.nodeRadius, "wire must reach the provider housing");
      assert.ok(endDistance >= layout.nodeRadius * 0.8, "wire must not cross the provider mark");
    }
  }
});

test("cable tips stay under the housings that are painted over them", () => {
  // ApexCore3D draws its cap at radiusTop = size * 0.47 and size is two core
  // radii, ProviderNode3D at radius * 0.96. A tip further out than those stands
  // proud of its own housing at that size, which is the same unplugged look the
  // fixed-pixel tuck produced on big cores.
  for (const centerRadius of [14, 22, 29, 42, 66, 96, 140]) {
    for (const nodeRadius of [7, 14, 21, 29, 40]) {
      // A span wide enough that the squeeze clamps (which legitimately pull the
      // anchors inward when a node is dragged onto the core) never bind here.
      const radii = wireAnchorRadii(centerRadius, nodeRadius, (centerRadius + nodeRadius) * 4);
      assert.ok(radii.start <= centerRadius * 0.94, `core tip ${radii.start} clears the cap of a ${centerRadius} core`);
      assert.ok(radii.end <= nodeRadius * 0.96, `node tip ${radii.end} clears the housing of a ${nodeRadius} node`);
      assert.ok(radii.start >= centerRadius * 0.62, `core tip ${radii.start} stays off the central logo`);
      assert.ok(radii.end >= nodeRadius * 0.8, `node tip ${radii.end} stays off the provider mark`);
    }
  }
});

test("wire dots exist only for providers working in the current run and are capped", () => {
  const list = providers(20);
  const layout = buildCoreLayout(list, { width: 960, height: 600 });
  const statuses = new Map(list.map((provider, index) => [provider.id, index < 3 ? "working" : "not_working"]));
  const dots = wireDots(layout, key => statuses.get(key));
  assert.equal(dots.length, 3);
  assert.equal(dots.every(node => statuses.get(node.key) === "working"), true);

  const many = providers(20);
  const manyLayout = buildCoreLayout(many, { width: 960, height: 600 });
  const allWorking = wireDots(manyLayout, () => "working", { maxDots: 5 });
  assert.ok(allWorking.length <= 5);

  const none = wireDots(layout, () => "not_working");
  assert.deepEqual(none, []);
});

test("layout is deterministic for the same provider inputs", () => {
  const a = buildCoreLayout(providers(6), { width: 800, height: 500 });
  const b = buildCoreLayout(providers(6), { width: 800, height: 500 });
  assert.deepEqual(
    a.nodes.map(node => [node.key, node.x, node.y, node.wire]),
    b.nodes.map(node => [node.key, node.x, node.y, node.wire])
  );
});
