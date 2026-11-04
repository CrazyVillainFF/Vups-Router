import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { buildCoreLayout } from "../src/combo/comboCoreLayout.js";
import { createNodeEntry } from "../src/combo/comboElastic.js";
import {
  CAMERA_FOV,
  DEPTH,
  PARALLAX_LAYERS,
  PARALLAX_PX,
  PX_TO_WORLD,
  cableReveal,
  cableWidth,
  cameraDistance,
  cameraOffset,
  coreModel,
  curveAt,
  curvePoints,
  entranceScale,
  nodeEntrance,
  nodeModel,
  parallaxLean,
  parallaxOffset,
  pulseSchedule,
  qualityTier,
  relaxedControl,
  startupPhase,
  toWorld,
  toWorldSize,
  wireAnchorsFor,
  wireStretch
} from "../src/combo/comboScene.js";

const VIEW = { width: 960, height: 600 };
const source = readFileSync(new URL("../src/combo/machine/ApexCore3D.jsx", import.meta.url), "utf8");

function layoutFor(count, view = VIEW) {
  return buildCoreLayout(
    Array.from({ length: count }, (_, index) => ({
      id: `provider:test-${index}`,
      name: `Provider ${index}`,
      artwork: { id: `test-${index}`, type: "wordmark", wordmark: `P${index}`, color: "#fff" },
      models: [],
      keys: []
    })),
    view
  );
}

function entryAt(layout, index = 0) {
  return createNodeEntry(layout.nodes[index], layout);
}

// The renderer copies these numbers straight into THREE object positions,
// scales and opacities. A single NaN makes the whole group disappear, so
// finiteness is the contract, not an implementation detail.
function assertFinite(value, label) {
  assert.equal(Number.isFinite(value), true, `${label} must be finite, got ${value}`);
}

function coreModelIsFinite(input, label) {
  const model = coreModel(input);
  for (const [key, value] of Object.entries(model)) {
    if (typeof value === "number") assertFinite(value, `${label}.${key}`);
  }
  return model;
}

test("camera distance keeps one linear world-to-pixel rule at the node plane", () => {
  for (const height of [348, 600, 900]) {
    const distance = cameraDistance(height);
    const worldPerPixel = (2 * Math.tan((CAMERA_FOV / 2) * (Math.PI / 180)) * distance) / height;
    assert.ok(Math.abs(worldPerPixel - PX_TO_WORLD) < 1e-9, `${height}px maps to ${worldPerPixel}`);
  }
  assert.equal(cameraDistance(0), 1, "a zero-height viewport still gets a usable camera");
});

// The whole DOM/3D contract rests on one thing: a mesh drawn at a node's world
// position has to land on that node's own css box. The ring center sits above the
// middle of the viewport because the bottom pad carries the captions, so the
// camera has to be parked over the ring center, not the box center.
test("a node drawn at its world position lands on its own dom box", () => {
  for (const count of [1, 4, 6, 12]) {
    for (const view of [VIEW, { width: 402, height: 348 }, { width: 1440, height: 720 }]) {
      const layout = layoutFor(count, view);
      const shift = cameraOffset(layout, view);
      const distance = cameraDistance(view.height);
      const tanHalf = Math.tan((CAMERA_FOV / 2) * (Math.PI / 180));
      const focal = distance * tanHalf;
      const aspect = view.width / view.height;
      for (const node of layout.nodes) {
        const world = toWorld(node.x, node.y, layout);
        const ndcX = (world.x - shift.x) / (focal * aspect);
        const ndcY = (world.y - shift.y) / focal;
        const screenX = (view.width * (1 + ndcX)) / 2;
        const screenY = (view.height * (1 - ndcY)) / 2;
        assert.ok(Math.abs(screenX - node.x) < 0.01, `${count} @ ${view.width}: x ${screenX} vs ${node.x}`);
        assert.ok(Math.abs(screenY - node.y) < 0.01, `${count} @ ${view.width}: y ${screenY} vs ${node.y}`);
      }
    }
  }
});

test("camera offset is zero for a centred layout and finite for a missing one", () => {
  const centered = cameraOffset({ width: 800, height: 400, center: { x: 400, y: 200 } }, { width: 800, height: 400 });
  assert.deepEqual([centered.x, centered.y], [0, 0]);
  const raised = cameraOffset({ width: 800, height: 400, center: { x: 400, y: 160 } }, { width: 800, height: 400 });
  assert.ok(raised.y < 0, "a ring center above the box center drops the camera in world space");
  const blind = cameraOffset({}, { width: 800, height: 400 });
  assertFinite(blind.x, "camera offset x without a layout");
  assertFinite(blind.y, "camera offset y without a layout");
});

test("toWorld centres the layout origin and flips the y axis", () => {
  const layout = layoutFor(6);
  const center = toWorld(layout.center.x, layout.center.y, layout);
  assert.deepEqual([center.x, center.y, center.z], [0, 0, 0]);
  const above = toWorld(layout.center.x, layout.center.y - 100, layout);
  assert.ok(above.y > 0, "css up is positive world y");
  const node = toWorld(layout.nodes[0].x, layout.nodes[0].y, layout);
  assertFinite(node.x, "node world x");
  assertFinite(node.y, "node world y");
});

test("toWorldSize rejects junk instead of poisoning the scene", () => {
  assert.equal(toWorldSize(26), 0.26);
  assert.equal(toWorldSize("nope"), 0);
  assert.equal(toWorldSize(undefined), 0);
  assert.equal(toWorldSize(-4), 0);
});

test("parallax offset stays finite for every pointer value", () => {
  const size = { width: 402, height: 348 };
  assert.deepEqual(parallaxOffset({ x: 0, y: 0 }, size), { x: -PARALLAX_PX.x, y: -PARALLAX_PX.y });
  const centered = parallaxOffset({ x: 201, y: 174 }, size);
  assert.equal(centered.x, 0);
  assert.equal(centered.y, 0);
  assert.deepEqual(parallaxOffset({ x: 402, y: 348 }, size), { x: PARALLAX_PX.x, y: PARALLAX_PX.y });
  // Out of range pointers clamp instead of running away.
  const clamped = parallaxOffset({ x: 9999, y: -9999 }, size);
  assert.deepEqual(clamped, { x: PARALLAX_PX.x, y: -PARALLAX_PX.y });
  for (const pointer of [undefined, null, { x: NaN, y: NaN }, {}, { x: "a", y: "b" }]) {
    const value = parallaxOffset(pointer, size);
    assertFinite(value.x, "parallaxOffset.x for a broken pointer");
    assertFinite(value.y, "parallaxOffset.y for a broken pointer");
  }
});

test("the pointer lean is finite, bounded and cross-axis", () => {
  const offset = { x: 20, y: 12 };
  for (const layer of Object.keys(PARALLAX_LAYERS)) {
    const lean = parallaxLean(offset, layer);
    assertFinite(lean.x, `${layer} lean x`);
    assertFinite(lean.y, `${layer} lean y`);
    // A horizontal pointer sweep yaws the housing, a vertical one pitches it, so
    // the wider x offset has to produce the larger rotation.
    assert.ok(Math.abs(lean.y) > Math.abs(lean.x), `${layer} maps x to the yaw axis`);
    // Monotonic: a bigger sweep never leans less.
    assert.ok(Math.abs(parallaxLean({ x: 26, y: 0 }, layer).y) >= Math.abs(lean.y), `${layer} leans with the pointer`);
  }
  const unknown = parallaxLean(offset, "unknown-layer");
  assert.equal(unknown.x, 0);
  assert.equal(unknown.y, 0);
  const missing = parallaxLean(undefined, "core");
  assert.equal(missing.x, 0);
  assert.equal(missing.y, 0);
  // Held under ~5 degrees. Past that the housing cap swings far enough sideways
  // to uncover the cable tip that is supposed to sit under it.
  const extreme = parallaxLean({ x: PARALLAX_PX.x, y: PARALLAX_PX.y }, "core");
  assert.ok(Math.max(Math.abs(extreme.x), Math.abs(extreme.y)) < 0.09, `core lean ${JSON.stringify(extreme)} stays a tip`);
});

test("the core housing keeps the pointer lean out of its position", () => {
  // Cables are anchored from layout.center and the camera is never rotated, so
  // the painted core silhouette has to stay on that point. A positional parallax
  // drifts the housing off the ends of the cables it is supposed to receive.
  assert.match(source, /parallaxLean\(parallaxRef\.current, "core"\)/, "the pointer drives a lean");
  assert.doesNotMatch(source, /groupRef\.current\.position\.[xyz]\s*=/, "and never a translation");
  assert.ok(!("position" in parallaxLean({ x: 20, y: 12 }, "core")), "the lean carries no position terms");
});

test("the machine does not hold a pointer lean once the pointer is gone", () => {
  const shell = readFileSync(new URL("../src/combo/ComboPowerCore.jsx", import.meta.url), "utf8");
  // A pointer parked at 0,0 is the top-left corner, which is the clamped extreme
  // of the lean, so an untouched machine has to start with no pointer at all and
  // drop it again when the cursor leaves the stage.
  assert.match(shell, /const pointerRef = useRef\(null\);/, "no lean before the first pointermove");
  assert.match(shell, /onPointerLeave=\{\(\) => \{[\s\S]{0,320}?pointerRef\.current = null;/, "leaving the stage relaxes the lean");
});

test("idle core reports no energy, glow, streams or receive rate", () => {
  const idle = coreModelIsFinite({}, "empty input");
  assert.equal(idle.state, "idle");
  assert.equal(idle.energy, 0);
  assert.equal(idle.glow, 0);
  assert.equal(idle.receive, 0);
  assert.equal(idle.logoPulse, 0);
  assert.equal(idle.ringSpread, 1);
  // Junk from the orchestrator can never lift the idle floor.
  const junk = coreModelIsFinite({ connected: "yes", runActive: 1, intensity: "x", liveWorking: null }, "junk input");
  assert.equal(junk.energy, 0, "only an explicit boolean connection counts");
});

test("core energy is driven by reported state, never by a timer", () => {
  const connected = coreModelIsFinite({ connected: true, intensity: 0.5 }, "connected");
  assert.equal(connected.state, "connected");
  assert.equal(connected.energy, 0.5);
  assert.equal(connected.receive, 0, "nothing is received until a run is active");

  const active = coreModelIsFinite(
    { connected: true, runActive: true, liveWorking: 4, intensity: 0.5 },
    "active run"
  );
  assert.equal(active.state, "active");
  assert.ok(active.receive > connected.receive, "an active run receives more");
  assert.ok(active.ringSpeed > connected.ringSpeed, "more providers working spins the rings faster");

  const capped = coreModelIsFinite({ runActive: true, liveWorking: 40, intensity: 2 }, "saturated");
  assert.ok(capped.energy <= 1 && capped.receive <= 1, "energy and receive stay capped");

  const single = coreModel({ connected: true, intensity: 0 });
  const many = coreModel({ connected: true, runActive: true, liveWorking: 1, intensity: 0 });
  assert.equal(single.energy, 0.18, "an engaged core keeps a floor so it never reads as broken");
  assert.ok(many.ringSpeed > single.ringSpeed);
});

test("node appearance follows live status and never claims activity", () => {
  assert.equal(nodeModel({}).emissive, 0.08);
  const live = nodeModel({ live: "working", status: "unknown" });
  assert.equal(live.stream, true);
  assert.equal(live.emissive, 1);
  assert.equal(live.halo, 1);

  const failed = nodeModel({ live: "failed", status: "working" });
  assert.equal(failed.stream, false, "a provider that failed stops transmitting mid-run");
  assert.equal(failed.emissive, 0);
  assert.equal(failed.rim, 0.1, "a failed node stays legible without pretending to work");

  const done = nodeModel({ live: "done" });
  assert.equal(done.stream, false);
  assert.ok(done.emissive > 0 && done.emissive < 1);

  const idleWorkingStatus = nodeModel({ status: "working" });
  assert.equal(idleWorkingStatus.stream, false, "an available credential is a linked cable, not traffic");
  assert.ok(idleWorkingStatus.emissive > 0, "the housing still reads as available while idle");

  assert.equal(nodeModel({ dragging: true }).scale, 1.12);
  assert.equal(nodeModel({ hovered: true }).scale, 1.07);
  assert.equal(nodeModel({ focused: true }).scale, 1.07);
});

// The connector picks one of four cable looks from exactly these three flags, so
// they are the whole contract between "what the run reported" and "what the
// harness shows". Selection is deliberately absent: it is a user action and must
// never be able to light a cable.
test("cable state flags answer only what the run reported", () => {
  const answering = nodeModel({ live: "working" });
  assert.equal(answering.stream, true);
  assert.equal(answering.linked, false, "live traffic does not need the availability colour");
  assert.equal(answering.blocked, false);

  const available = nodeModel({ status: "working" });
  assert.equal(available.linked, true, "a verified credential is a linked, quiet cable");
  assert.equal(available.stream, false);
  assert.equal(available.blocked, false);

  const unavailable = nodeModel({ status: "not_working" });
  assert.equal(unavailable.blocked, true, "a provider that proved unavailable reads as an inert cable");
  assert.equal(unavailable.linked, false);
  assert.equal(unavailable.stream, false);

  const failedMidRun = nodeModel({ live: "failed", status: "working" });
  assert.equal(failedMidRun.blocked, true, "failing during a run overrides the earlier availability");
  assert.equal(failedMidRun.stream, false);

  const selected = nodeModel({ selected: true, status: "not_working" });
  assert.equal(selected.stream, false, "being the provider on screen is not activity");
  assert.equal(selected.blocked, true, "selection cannot promote an unavailable provider");

  const unknown = nodeModel({ status: "unknown" });
  assert.equal(unknown.linked, false, "unverified availability gets the idle cable, not the linked one");
  assert.equal(unknown.blocked, false);
});

test("3D cable anchors are the same points the SVG fallback draws", () => {
  const layout = layoutFor(8);
  for (const node of layout.nodes) {
    const entry = createNodeEntry(node, layout);
    const { start, end, distance } = wireAnchorsFor(entry, layout);
    for (const point of [start, end]) {
      assertFinite(point.x, "wire anchor x");
      assertFinite(point.y, "wire anchor y");
    }
    const startRadius = Math.hypot(start.x - layout.center.x, start.y - layout.center.y);
    const endGap = Math.hypot(end.x - entry.node.x, end.y - entry.node.y);
    // Each tip has to sit inside the housing it plugs into - stopping outside the
    // rim is a visible air gap - but never so deep that it reaches the artwork
    // painted on that housing (the central logo is 46% of the core radius, a
    // provider mark 60% of the node radius including its corners).
    assert.ok(startRadius <= layout.centerRadius, "the core end tucks under the housing");
    assert.ok(startRadius >= layout.centerRadius * 0.8, "the core end stays off the central logo");
    assert.ok(endGap <= layout.nodeRadius, "the provider end tucks under the housing");
    assert.ok(endGap >= layout.nodeRadius * 0.8, "the provider end stays off the provider mark");
    assert.ok(startRadius + endGap < distance, "the two anchors never cross");
    // Parsing the svg path for the same node must start at the same anchor.
    const [mx, my] = node.wire.split("Q")[0].slice(2).trim().split(/\s+/).map(Number);
    assert.ok(Math.abs(mx - start.x) < 0.1 && Math.abs(my - start.y) < 0.1, "shared start anchor");
  }
});

// The harness has to look wired at one provider and at a full twelve-node
// network, on a desktop card and on a phone card, because the density scaling
// changes every radius the anchors are measured against.
test("every node count plugs both ends of every cable into a housing", () => {
  for (const view of [{ width: 1440, height: 820 }, { width: 960, height: 600 }, { width: 390, height: 340 }]) {
    for (const count of [1, 2, 4, 6, 8, 10, 12]) {
      const layout = layoutFor(count, view);
      for (const node of layout.nodes) {
        const entry = createNodeEntry(node, layout);
        const { start, end, distance } = wireAnchorsFor(entry, layout);
        const startRadius = Math.hypot(start.x - layout.center.x, start.y - layout.center.y);
        const endRadius = Math.hypot(end.x - node.x, end.y - node.y);
        assert.ok(startRadius <= layout.centerRadius, `${count}@${view.width}px: core end floats ${startRadius.toFixed(1)} > ${layout.centerRadius}`);
        assert.ok(endRadius <= layout.nodeRadius, `${count}@${view.width}px: node end floats ${endRadius.toFixed(1)} > ${layout.nodeRadius}`);
        assert.ok(startRadius + endRadius < distance, `${count}@${view.width}px: the anchors crossed`);
        assert.ok(startRadius > 0 && endRadius > 0, "an anchor never sits on a housing centre");
      }
    }
  }
});

// The DOM spring layer moves nodes without rebuilding the layout, so the anchors
// must come from the live entry position every frame. A connector that cached the
// home coordinates would leave its cable behind the moment anything moved.
test("a cable re-anchors from the live node position, not its home", () => {
  const layout = layoutFor(6);
  const entry = entryAt(layout, 0);
  const before = wireAnchorsFor(entry, layout);
  const beforeEnd = Math.hypot(before.end.x - entry.node.x, before.end.y - entry.node.y);
  entry.node.x += 90;
  entry.node.y -= 60;
  const after = wireAnchorsFor(entry, layout);
  const afterEnd = Math.hypot(after.end.x - entry.node.x, after.end.y - entry.node.y);
  assert.notEqual(after.end.x, before.end.x, "the provider end follows the node");
  assert.ok(afterEnd <= layout.nodeRadius, "the moved node is still plugged in");
  assert.ok(Math.abs(afterEnd - beforeEnd) < 0.01, "the plug depth depends on the radius, not the position");
  const span = Math.hypot(entry.node.x - layout.center.x, entry.node.y - layout.center.y);
  assert.ok(Math.abs(after.distance - span) < 1e-9, "the anchor distance is the live span");
  for (const point of curvePoints(entry, layout, qualityTier({ width: 1440 }).segments)) {
    assertFinite(point.x, "moved cable sample x");
    assertFinite(point.y, "moved cable sample y");
  }
});

test("a dragged node keeps finite anchors close to the core", () => {
  const layout = layoutFor(4);
  const entry = entryAt(layout, 0);
  entry.node.x = layout.center.x + 2;
  entry.node.y = layout.center.y + 2;
  const { start, end, distance } = wireAnchorsFor(entry, layout);
  assertFinite(start.x, "short wire start x");
  assertFinite(end.x, "short wire end x");
  assert.ok(distance > 0, "the anchors never coincide");
  const curve = curvePoints(entry, layout, 12);
  assert.equal(curve.length, 13);
  for (const point of curve) {
    assertFinite(point.x, "curve sample x");
    assertFinite(point.y, "curve sample y");
  }
});

test("energy travels provider to core", () => {
  const layout = layoutFor(6);
  const entry = entryAt(layout, 1);
  const { start, end } = wireAnchorsFor(entry, layout);
  const atProvider = curveAt(entry, layout, 0);
  const atCore = curveAt(entry, layout, 1);
  assert.ok(Math.hypot(atProvider.x - end.x, atProvider.y - end.y) < 1e-6, "t=0 is the provider end");
  assert.ok(Math.hypot(atCore.x - start.x, atCore.y - start.y) < 1e-6, "t=1 is the core end");
  assert.deepEqual([curveAt(entry, layout, -5).x, curveAt(entry, layout, 9).x].map(Number.isFinite), [true, true]);
});

test("wire stretch reads how far the cable was pulled", () => {
  const layout = layoutFor(5);
  const entry = entryAt(layout, 0);
  entry.wire.x = relaxedControl(entry, layout).x;
  entry.wire.y = relaxedControl(entry, layout).y;
  assert.equal(wireStretch(entry, layout), 0, "at rest the cable is relaxed");
  entry.wire.x += 120;
  assert.equal(wireStretch(entry, layout), 1, "stretch is capped");
  assertFinite(wireStretch(entryAt(layout, 2), layout), "stretch of an untouched cable");
});

test("quality tiers degrade on real device signals", () => {
  const desktop = qualityTier({ width: 1440, height: 900, deviceMemory: 16, hardwareConcurrency: 12 });
  const phone = qualityTier({ width: 420, height: 720, deviceMemory: 4, hardwareConcurrency: 4 });
  const weak = qualityTier({ width: 420, deviceMemory: 2, hardwareConcurrency: 2 });
  const reduced = qualityTier({ width: 1440, reduced: true });
  assert.equal(desktop.dpr, 2);
  assert.ok(phone.segments < desktop.segments, "a small screen samples the cables less finely");
  assert.equal(weak.dpr, 1);
  assert.equal(reduced.dpr, 1);
  assert.equal(reduced.pulses, 1, "reduced motion gets the cheapest tier");
  for (const tier of [desktop, phone, weak, reduced]) {
    assert.ok(tier.segments >= 8 && tier.segments <= 32, `segments ${tier.segments}`);
    assert.ok(tier.pulses >= 1 && tier.pulses <= 3, `pulses ${tier.pulses}`);
  }
});

test("a cable stays a couple of pixels wide instead of becoming a blade", () => {
  const atRest = cableWidth(25);
  assert.ok(atRest > 0 && atRest < 0.14, `a 50px node gets a ${atRest} world-unit cable, not a surface`);
  assert.equal(cableWidth(0), 0, "a node with no radius has no cable");
  for (const junk of [undefined, null, NaN, "wide", -20]) {
    assertFinite(cableWidth(junk), "cable width for junk radius");
    assert.ok(cableWidth(junk) >= 0, "cable width never goes negative");
  }
  assert.equal(cableWidth(25, 1) < atRest, true, "a pulled cable narrows");
  assert.equal(cableWidth(25, 9), cableWidth(25, 1), "narrowing is capped so a cable never vanishes");
});

test("the composition leaves the core dominant without filling the card", () => {
  for (const view of [{ width: 960, height: 600 }, { width: 402, height: 348 }]) {
    const layout = layoutFor(10, view);
    const coreRatio = layout.centerSize / Math.min(view.width, view.height);
    assert.ok(coreRatio > 0.2 && coreRatio < 0.4, `core takes ${(coreRatio * 100).toFixed(0)}% of the short axis`);
    // The node ring is an ellipse, so a wide card earns its width: containment
    // is per-axis, never against the shorter side.
    for (const node of layout.nodes) {
      assert.ok(
        Math.abs(node.x - layout.center.x) + layout.nodeRadius + 10 <= view.width / 2,
        `node x ${node.x.toFixed(1)} clears the card edge`
      );
      assert.ok(
        Math.abs(node.y - layout.center.y) + layout.nodeRadius + 10 <= view.height / 2,
        `node y ${node.y.toFixed(1)} clears the card edge`
      );
    }
    const radii = layout.nodes.map(node => Math.hypot(node.x - layout.center.x, node.y - layout.center.y));
    assert.ok(
      Math.min(...radii) > layout.centerRadius + layout.nodeRadius,
      "no node is allowed to sit on top of the core"
    );
  }
});

test("cables leave the core rim and stop at the node rim", () => {
  const layout = layoutFor(8);
  for (const node of layout.nodes) {
    const entry = createNodeEntry(node, layout);
    const control = relaxedControl(entry, layout);
    const { start, end } = wireAnchorsFor(entry, layout);
    // The curve bows off the midpoint of the trimmed anchors, not of the
    // node/centre pair: the housings eat the first few pixels of every cable.
    const bow = Math.hypot(control.x - (start.x + end.x) / 2, control.y - (start.y + end.y) / 2);
    assert.ok(bow <= 12.001, `a relaxed cable bows ${bow.toFixed(1)}px at most so ten of them never cross`);
    assertFinite(bow, "control bow");
  }
});

test("entrance progress maps 0..1 without negative scales", () => {
  assert.ok(entranceScale(0) < 1e-9, `entranceScale(0) = ${entranceScale(0)}`);
  assert.equal(entranceScale(1), 1);
  assert.ok(entranceScale(undefined) < 1e-9);
  assert.ok(entranceScale("nope") < 1e-9);
  for (const value of [-3, -0.5, 0.25, 0.5, 0.75, 1.4]) {
    const scale = entranceScale(value);
    assertFinite(scale, `entranceScale(${value})`);
    assert.ok(scale >= 0 && scale <= 1.15, `entrance scale ${scale} stays in range`);
  }
  assert.ok(entranceScale(0.5) > entranceScale(0.25), "the machine grows as the entrance plays");
});

test("pulse schedule spaces simultaneous streams apart", () => {
  const six = Array.from({ length: 6 }, (_, index) => pulseSchedule(index, 6));
  const delays = new Set(six.map(p => p.delay.toFixed(3)));
  assert.equal(delays.size, 6, "no two providers start on the same beat");
  for (const pulse of six) {
    assert.ok(pulse.duration >= 0.6 && pulse.duration <= 2.1, `duration ${pulse.duration}`);
    assert.ok(pulse.offset >= 0 && pulse.offset < 1);
  }
  const busy = Array.from({ length: 10 }, (_, index) => pulseSchedule(index, 10));
  assert.ok(busy[0].duration < six[0].duration, "more providers travel faster");
  assert.equal(pulseSchedule(0, 0, 0).duration, 2.1, "junk count and speed fall back");
});

test("every face sits above the body that would otherwise hide it", () => {
  // three.js draws a solid cylinder with caps, so anything meant to be seen on
  // the front of a housing has to be in front of housing/2 or it is occluded.
  const halfBody = DEPTH.housing / 2;
  for (const key of ["well", "groove", "rim", "energy", "logo"]) {
    assert.ok(DEPTH[key] > halfBody, `core ${key} at ${DEPTH[key]} sits above the ${halfBody} body cap`);
  }
  assert.deepEqual(
    [DEPTH.well, DEPTH.groove, DEPTH.rim, DEPTH.energy, DEPTH.logo],
    [DEPTH.well, DEPTH.groove, DEPTH.rim, DEPTH.energy, DEPTH.logo].slice().sort((a, b) => a - b),
    "the core stack is ordered front to back"
  );
  const nodeHalf = DEPTH.node / 2;
  for (const key of ["nodeFace", "nodeMark", "nodeRim"]) {
    assert.ok(DEPTH[key] > nodeHalf, `node ${key} at ${DEPTH[key]} sits above the ${nodeHalf} body cap`);
  }
});

test("every value the renderer copies into three.js is finite", () => {
  const layout = layoutFor(7, { width: 402, height: 348 });
  const core = coreModelIsFinite({ connected: true, runActive: true, liveWorking: 3, intensity: 0.6 }, "core");
  const pointer = parallaxOffset({ x: 130, y: 96 }, { width: 402, height: 348 });
  const distance = cameraDistance(348);
  assertFinite(distance, "camera distance");
  for (const lean of Object.keys(PARALLAX_LAYERS).map(layer => parallaxLean(pointer, layer))) {
    assertFinite(lean.x, "layer lean x");
    assertFinite(lean.y, "layer lean y");
  }
  for (const node of layout.nodes) {
    const entry = createNodeEntry(node, layout);
    const visual = nodeModel({ status: "working", live: "working" });
    const world = toWorld(entry.node.x, entry.node.y, layout);
    const radius = toWorldSize(layout.nodeRadius);
    assertFinite(world.x, "node mesh x");
    assertFinite(world.y, "node mesh y");
    assert.ok(radius > 0, "node mesh radius");
    assertFinite(visual.scale, "node scale");
    assertFinite(visual.emissive, "node emissive");
    assertFinite(wireStretch(entry, layout), "stretch");
    assertFinite(cableWidth(layout.nodeRadius, wireStretch(entry, layout)), "cable width");
    assert.ok(entranceScale(1) * visual.scale > 0, "rendered node scale is never zero");
  }
  assert.ok(core.energy > 0 && core.glow > 0, "an engaged core has something to render");
});

test("the startup driver maps every phase window onto one monotonic run", () => {
  const order = ["environment", "assembly", "initialize", "discovery", "connection", "activation"];
  for (const phase of order) {
    assert.equal(startupPhase(0, phase), 0, `${phase} has not begun at cold`);
    assert.equal(startupPhase(1, phase), 1, `${phase} is fully open at the end of the run`);
    assert.equal(startupPhase(undefined, phase), 0, `${phase} survives a missing driver`);
    assert.equal(startupPhase(-2, phase), 0, `${phase} clamps below`);
    assert.equal(startupPhase(7, phase), 1, `${phase} clamps above`);
  }
  assert.equal(startupPhase(1, "not-a-phase"), 1, "an unknown phase is treated as already done");

  // The window order is the boot order the brief asks for, and each stage has to
  // be visibly ahead of the one before it at the same point in the run.
  const mid = 0.55;
  const at = mid;
  const values = order.map(phase => startupPhase(at, phase));
  for (let index = 1; index < order.length; index += 1) {
    assert.ok(
      values[index - 1] >= values[index],
      `${order[index - 1]} (${values[index - 1]}) leads ${order[index]} (${values[index]}) at driver ${mid}`
    );
  }
  assert.ok(startupPhase(mid, "environment") === 1, "the room light is up before anything moves");
  assert.ok(startupPhase(mid, "activation") === 0, "the core is not yet lit at the halfway point");
  assert.ok(startupPhase(0.84, "discovery") === 1, "providers are all found before the cables join");
  assert.ok(startupPhase(0.9, "connection") < 1, "the cables are still joining as the core ignites");

  let previous = -1;
  for (let step = 0; step <= 100; step += 1) {
    const driver = step / 100;
    for (const phase of order) {
      const value = startupPhase(driver, phase);
      assertFinite(value, `startupPhase(${driver}, ${phase})`);
      assert.ok(value >= 0 && value <= 1, `${phase} stays inside 0..1 at ${driver}`);
    }
    const activation = startupPhase(driver, "activation");
    assert.ok(activation >= previous, "no phase ever moves backwards");
    previous = activation;
  }
});

test("node entrance sweeps without leaving a node permanently hidden", () => {
  for (const count of [1, 2, 5, 10, 20]) {
    const arrivals = Array.from({ length: count }, (_, index) => nodeEntrance(1, index, count));
    assert.deepEqual(
      arrivals,
      Array.from({ length: count }, () => 1),
      `every one of ${count} nodes is fully arrived at the end of discovery`
    );
    assert.equal(nodeEntrance(0, 0, count), 0, "the first node is still closed at progress 0");
    const spread = Array.from({ length: count }, (_, index) => nodeEntrance(0.55, index, count));
    for (const value of spread) {
      assertFinite(value, `nodeEntrance(0.55, n=${count})`);
      assert.ok(value >= 0 && value <= 1, `${count} nodes stay inside 0..1`);
    }
    if (count > 1) {
      assert.ok(
        spread[0] >= spread[count - 1],
        `the sweep leads from the first node: ${spread[0]} vs ${spread[count - 1]}`
      );
      assert.ok(spread.some((value, index) => index > 0 && value < spread[index - 1]),
        `n=${count} actually stagger the arrivals`);
    }
  }
  assert.equal(nodeEntrance(0.5, 99, 3), nodeEntrance(0.5, 2, 3), "an index past the end clamps");
  assert.equal(nodeEntrance(0.5, -4, 3), nodeEntrance(0.5, 0, 3), "a negative index clamps");
  assert.equal(nodeEntrance("x", 0, 1), 0, "junk progress falls back to closed");
  assert.equal(nodeEntrance(1, 0, 0), 1, "junk count still arrives");
});

test("cables and nodes reach the same openness so nothing floats unattached", () => {
  assert.equal(cableReveal(0), 0.08, "a cable starts as a stub at the core, not a phantom line");
  assert.equal(cableReveal(1), 1, "and it joins completely");
  for (const count of [1, 4, 10]) {
    for (let step = 0; step <= 20; step += 1) {
      const progress = step / 20;
      const discovery = startupPhase(progress, "discovery");
      for (let index = 0; index < count; index += 1) {
        const arrival = nodeEntrance(discovery, index, count);
        const reveal = Math.min(cableReveal(startupPhase(progress, "connection")), Math.max(0, arrival));
        assertFinite(reveal, `cable reveal at ${progress}/${index}/${count}`);
        assert.ok(reveal >= 0 && reveal <= 1, `cable reveal ${reveal} stays in range`);
        if (arrival < 0.999) {
          assert.ok(reveal <= arrival + 1e-9, `node ${index} never outruns its own cable`);
        }
      }
    }
  }
});

