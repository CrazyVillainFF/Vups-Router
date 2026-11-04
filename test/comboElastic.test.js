import test from "node:test";
import assert from "node:assert/strict";
import { buildCoreLayout } from "../src/combo/comboCoreLayout.js";
import {
  NODE_SPRING,
  WIRE_SPRING,
  clampToBounds,
  createSpring,
  entryHome,
  entryWirePath,
  moveEntry,
  resetEntry,
  setNodeTransform,
  setSpringTarget,
  springAtRest,
  stepEntry,
  stepSpring,
  syncEntries,
  wireTension
} from "../src/combo/comboElastic.js";

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

function layoutOf(count, width = 960, height = 600) {
  return buildCoreLayout(providers(count), { width, height });
}

function entriesFor(layout) {
  const entries = new Map();
  syncEntries(entries, layout);
  return entries;
}

test("a released spring settles on its target without ringing or exploding", () => {
  const spring = createSpring(0, 0);
  setSpringTarget(spring, 100, 40);
  let frames = 0;
  let overshoot = 0;
  let atRest = false;
  while (!atRest && frames < 600) {
    atRest = stepSpring(spring, NODE_SPRING, 16);
    overshoot = Math.max(overshoot, spring.x - 100, spring.y - 40);
    frames += 1;
  }
  assert.equal(atRest, true, "the spring must reach rest");
  assert.ok(frames < 120, `settled in ${frames} frames`);
  assert.ok(overshoot < 12, `overshoot ${overshoot.toFixed(2)}px must stay subtle`);
  assert.equal(spring.x, 100);
  assert.equal(spring.y, 40);
  assert.equal(spring.vx, 0);
  assert.equal(spring.vy, 0);
});

test("spring motion is frame-rate independent and survives a stalled frame", () => {
  const build = dt => {
    const spring = createSpring(0, 0);
    setSpringTarget(spring, 100, 0);
    for (let index = 0; index < Math.round(500 / dt); index += 1) stepSpring(spring, NODE_SPRING, dt);
    return spring;
  };
  const sixty = build(16);
  const thirty = build(33);
  assert.ok(Math.abs(sixty.x - thirty.x) < 1.5, `${sixty.x} vs ${thirty.x}`);

  const stalled = createSpring(0, 0);
  setSpringTarget(stalled, 100, 0);
  stepSpring(stalled, NODE_SPRING, 9000);
  assert.ok(Number.isFinite(stalled.x) && Number.isFinite(stalled.vx));
  assert.ok(stalled.x < 120, "a stalled frame must not launch the node");

  const broken = createSpring(Number.NaN, 0);
  setSpringTarget(broken, 10, 10);
  assert.equal(stepSpring(broken, NODE_SPRING, 16), true);
  assert.equal(broken.x, 10);
});

test("wire tension flattens a fast-moving wire and relaxes when it stops", () => {
  assert.equal(wireTension(0), 1);
  assert.ok(wireTension(400) < wireTension(40));
  assert.ok(wireTension(9000) >= 0.18);
  assert.ok(wireTension(-50) === 1);
});

test("a dragged node stays inside the core and keeps its new home", () => {
  const layout = layoutOf(4);
  const entries = entriesFor(layout);
  const entry = entries.get(layout.nodes[0].key);
  const far = moveEntry(entry, 4000, -3000, layout);
  assert.equal(far.x, layout.bounds.maxX);
  assert.equal(far.y, layout.bounds.minY);
  assert.equal(stepEntry(entry, layout, 16), false);
  for (let index = 0; index < 400; index += 1) stepEntry(entry, layout, 16);
  assert.equal(entry.node.x, layout.bounds.maxX);
  assert.equal(entry.node.y, layout.bounds.minY);

  const inside = moveEntry(entry, 300, 220, layout);
  assert.equal(inside.x, 300);
  assert.equal(inside.y, 220);
  assert.deepEqual(clampToBounds(300, 220, layout.bounds), { x: 300, y: 220 });
});

test("dragged positions are proportional so a resize keeps the arrangement", () => {
  const wide = layoutOf(4, 960, 600);
  const entries = entriesFor(wide);
  const entry = entries.get(wide.nodes[1].key);
  moveEntry(entry, 700, 150, wide);
  const narrow = layoutOf(4, 480, 300);
  syncEntries(entries, narrow);
  const home = entryHome(entry, narrow);
  assert.ok(Math.abs(home.x - 350) < 0.001, `expected 350, got ${home.x}`);
  assert.ok(Math.abs(home.y - 75) < 0.001, `expected 75, got ${home.y}`);
  assert.ok(home.x >= narrow.bounds.minX && home.x <= narrow.bounds.maxX);
});

test("reset returns a node to its computed ring position", () => {
  const layout = layoutOf(6);
  const entries = entriesFor(layout);
  const node = layout.nodes[3];
  const entry = entries.get(node.key);
  moveEntry(entry, node.x + 120, node.y + 90, layout);
  assert.notEqual(entry.normX, null);
  resetEntry(entry, layout);
  assert.equal(entry.normX, null);
  assert.equal(entry.normY, null);
  for (let index = 0; index < 400; index += 1) stepEntry(entry, layout, 16);
  assert.equal(entry.node.x, node.x);
  assert.equal(entry.node.y, node.y);
});

test("the wire endpoint stays attached to the dragged node and keeps its path grammar", () => {
  const layout = layoutOf(4);
  const entries = entriesFor(layout);
  const node = layout.nodes[0];
  const entry = entries.get(node.key);
  moveEntry(entry, node.x + 60, node.y + 40, layout);
  stepEntry(entry, layout, 16);
  const path = entryWirePath(entry, layout);
  const match = path.match(/M (-?[\d.]+) (-?[\d.]+) Q (-?[\d.]+) (-?[\d.]+) (-?[\d.]+) (-?[\d.]+)/);
  assert.ok(match, path);
  const endX = Number(match[5]);
  const endY = Number(match[6]);
  const distance = Math.hypot(endX - entry.node.x, endY - entry.node.y);
  assert.ok(distance <= layout.nodeRadius, "the wire must plug into the node housing");
  // The provider mark is 60% of the node width, so its corner diagonals reach
  // 0.79 of the radius; a cable tip has to stay outside that band.
  assert.ok(distance >= layout.nodeRadius * 0.8, "the plug must stay clear of the provider artwork");
});

test("reduced motion places nodes and wires instantly with no interpolation", () => {
  const layout = layoutOf(4);
  const entries = entriesFor(layout);
  const node = layout.nodes[0];
  const entry = entries.get(node.key);
  const placed = moveEntry(entry, node.x + 150, node.y + 60, layout, true);
  assert.equal(springAtRest(entry.node), true, "reduced motion must not leave a spring running");
  assert.equal(entry.node.x, placed.x);
  assert.equal(entry.node.y, placed.y);
  assert.equal(stepEntry(entry, layout, 16, true), true);
  assert.equal(entry.wire.vx, 0);
  assert.equal(entry.wire.vy, 0);
});

test("provider identity survives layout rebuilds and prunes removed nodes", () => {
  const layout = layoutOf(5);
  const entries = entriesFor(layout);
  const kept = entries.get(layout.nodes[2].key);
  moveEntry(kept, 500, 300, layout);
  const smaller = layoutOf(3);
  syncEntries(entries, smaller);
  assert.equal(entries.size, 3);
  assert.equal(entries.get(smaller.nodes[2].key), kept, "same provider keeps the same spring entry");
  assert.equal(kept.normX !== null, true, "a dragged position survives a rerender");
});

test("node transforms are written as a spring offset and the loop reports rest", () => {
  const layout = layoutOf(4);
  const entries = entriesFor(layout);
  const node = layout.nodes[0];
  const entry = entries.get(node.key);
  const written = { style: { transform: "", setProperty() {} } };
  setNodeTransform(written, entry);
  assert.equal(written.style.transform, "translate(calc(-50% + 0.00px), calc(-50% + 0.00px))");
  moveEntry(entry, node.x + 30, node.y, layout);
  setNodeTransform(written, entry);
  assert.equal(stepEntry(entry, layout, 16), false, "still moving");
  for (let index = 0; index < 400; index += 1) stepEntry(entry, layout, 16);
  setNodeTransform(written, entry);
  assert.match(written.style.transform, /-50% \+ 30\.00px/);
  assert.equal(stepEntry(entry, layout, 16), true, "at rest");
  assert.notEqual(entry.node.x, entry.wire.x);
});

test("the wire trails its moving node and both springs settle after release", () => {
  const layout = layoutOf(5);
  const entries = entriesFor(layout);
  for (const node of layout.nodes) {
    const entry = entries.get(node.key);
    const startX = entry.node.x;
    const startY = entry.node.y;
    moveEntry(entry, node.x + 180, node.y - 90, layout);

    let peakLag = 0;
    let nodeTravel = 0;
    for (let frame = 0; frame < 12; frame += 1) {
      stepEntry(entry, layout, 16);
      peakLag = Math.max(
        peakLag,
        Math.hypot(entry.wire.targetX - entry.wire.x, entry.wire.targetY - entry.wire.y)
      );
      nodeTravel = Math.hypot(entry.node.x - startX, entry.node.y - startY);
    }
    assert.ok(peakLag > 10, `${node.key}: lag peaked at ${peakLag.toFixed(1)}px`);
    assert.ok(nodeTravel > peakLag, "the control point must not outrun the node");

    for (let frame = 0; frame < 400; frame += 1) stepEntry(entry, layout, 16);
    assert.equal(stepEntry(entry, layout, 16), true, `${node.key} must reach rest`);
    assert.equal(springAtRest(entry.node), true);
    assert.equal(springAtRest(entry.wire), true);
    assert.equal(
      Math.hypot(entry.wire.targetX - entry.wire.x, entry.wire.targetY - entry.wire.y),
      0,
      "a settled wire has no stored tension"
    );
  }
  assert.ok(WIRE_SPRING.damping < 2 * Math.sqrt(WIRE_SPRING.stiffness) + 1);
});

test("one dragged provider does not disturb the others", () => {
  const layout = layoutOf(6);
  const entries = entriesFor(layout);
  const dragged = entries.get(layout.nodes[2].key);
  const stillHome = [...entries.values()].filter(entry => entry !== dragged);
  moveEntry(dragged, 120, 500, layout);
  for (let frame = 0; frame < 40; frame += 1) stepEntry(dragged, layout, 16);
  for (const entry of stillHome) {
    assert.equal(entry.normX, null, `${entry.key} keeps its ring position`);
    assert.equal(stepEntry(entry, layout, 16), true);
    assert.equal(entry.node.x, entry.homeX);
    assert.equal(entry.node.y, entry.homeY);
  }
  assert.notEqual(dragged.node.x, dragged.homeX);
});

test("a resize lands every node on its new home with no flight across the canvas", () => {
  // The first measured box replaces the fallback viewBox: every home position
  // moves at once, so nodes must jump instead of springing hundreds of pixels.
  const entries = entriesFor(layoutOf(4, 960, 600));
  const narrow = layoutOf(4, 403.2, 340);
  syncEntries(entries, narrow);

  const written = { style: { transform: "", setProperty() {} } };
  for (const node of narrow.nodes) {
    const entry = entries.get(node.key);
    assert.equal(entry.node.x, node.x, `${entry.key} x lands on the new home`);
    assert.equal(entry.node.y, node.y, `${entry.key} y lands on the new home`);
    assert.equal(springAtRest(entry.node), true);
    assert.equal(springAtRest(entry.wire), true);
    assert.equal(stepEntry(entry, narrow, 16), true, "a settled resize needs no animation frames");
    setNodeTransform(written, entry);
    assert.equal(written.style.transform, "translate(calc(-50% + 0.00px), calc(-50% + 0.00px))");

    const match = entryWirePath(entry, narrow).match(
      /M (-?[\d.]+) (-?[\d.]+) Q (-?[\d.]+) (-?[\d.]+) (-?[\d.]+) (-?[\d.]+)/
    );
    assert.ok(match, entryWirePath(entry, narrow));
    const endX = Number(match[5]);
    const endY = Number(match[6]);
    const distance = Math.hypot(endX - entry.node.x, endY - entry.node.y);
    assert.ok(
      distance <= narrow.nodeRadius && distance >= narrow.nodeRadius * 0.8,
      `the wire stays plugged into the new box (${distance.toFixed(2)}px of ${narrow.nodeRadius.toFixed(2)}px)`
    );
  }
});

test("a dragged node keeps its share of the box when a resize snaps it", () => {
  const wide = layoutOf(4, 960, 600);
  const entries = entriesFor(wide);
  const entry = entries.get(wide.nodes[1].key);
  moveEntry(entry, 700, 150, wide);
  const narrow = layoutOf(4, 480, 300);
  syncEntries(entries, narrow);
  assert.equal(entry.node.x, 350);
  assert.equal(entry.node.y, 75);
  assert.equal(springAtRest(entry.node), true, "the resize must not leave a spring running");
});

test("a provider-set change at the same size still glides to the new ring spot", () => {
  const layout = layoutOf(4, 960, 600);
  const entries = entriesFor(layout);
  const before = new Map(layout.nodes.map(node => [node.key, { x: node.x, y: node.y }]));
  const grown = layoutOf(7, 960, 600);
  syncEntries(entries, grown);

  // Same geometry, so a re-spaced ring is an ordinary move: the spring owns it.
  const moved = grown.nodes.filter(node => {
    const old = before.get(node.key);
    return old && (Math.abs(old.x - node.x) > 1 || Math.abs(old.y - node.y) > 1);
  });
  assert.ok(moved.length > 0, "adding providers must re-space the ring");
  for (const node of moved) {
    const entry = entries.get(node.key);
    const home = entryHome(entry, grown);
    assert.equal(entry.node.x, before.get(node.key).x, `${node.key} has not teleported`);
    assert.equal(stepEntry(entry, grown, 16), false, "it animates toward the new ring position");
    for (let frame = 0; frame < 400; frame += 1) stepEntry(entry, grown, 16);
    assert.equal(entry.node.x, home.x);
    assert.equal(entry.node.y, home.y);
  }
});

