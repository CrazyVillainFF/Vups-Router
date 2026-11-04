import test from "node:test";
import assert from "node:assert/strict";
import {
  currentComboRun,
  endComboRun,
  reportComboEvent,
  startComboRun,
  subscribeComboRun
} from "../src/combo/comboLive.js";

function collect() {
  const seen = [];
  const unsubscribe = subscribeComboRun(state => seen.push(state));
  return { seen, unsubscribe };
}

test("a chat-driven run feeds real orchestration state to the provider network", (t) => {
  startComboRun();
  const { seen, unsubscribe } = collect();
  t.after(() => {
    unsubscribe();
    endComboRun();
  });

  assert.equal(seen[0].running, true, "a new subscriber learns the run is live immediately");
  assert.equal(seen[0].activity.size, 0);

  reportComboEvent({ type: "stage", phase: "checking", message: "Checking which models work" });
  reportComboEvent({
    type: "pool",
    active: [{ key: "saved:cfg-1:claude" }, { key: "shared:llama" }],
    excluded: [{ key: "vups:vups-v3-galax" }],
    deferredCount: 1,
    selectedCount: 3
  });
  reportComboEvent({ type: "model", key: "saved:cfg-1:claude", status: "started" });
  reportComboEvent({ type: "model", key: "shared:llama", status: "finished", latencyMs: 900 });
  reportComboEvent({ type: "model", key: "vups:vups-v3-galax", status: "failed" });

  const latest = currentComboRun();
  assert.equal(latest.running, true);
  assert.deepEqual(latest.stage, { phase: "checking", message: "Checking which models work" });
  assert.equal(latest.pool.selectedCount, 3);
  assert.equal(latest.pool.excluded.length, 1);
  assert.deepEqual([...latest.activity.entries()], [
    ["saved:cfg-1:claude", "working"],
    ["shared:llama", "done"],
    ["vups:vups-v3-galax", "failed"]
  ]);
  assert.ok(seen.length > 1, "each reported event republishes a new snapshot");
  assert.notEqual(seen[0].activity, seen[seen.length - 1].activity, "subscribers get a fresh map, not a mutation");
});

test("the network goes back to idle when the run ends", (t) => {
  startComboRun();
  const { unsubscribe } = collect();
  t.after(unsubscribe);
  reportComboEvent({ type: "pool", active: [{ key: "saved:cfg-1:claude" }] });
  reportComboEvent({ type: "model", key: "saved:cfg-1:claude", status: "started" });
  reportComboEvent({ type: "done", conversationId: "conv-1", selectedCount: 1 });
  assert.equal(currentComboRun().activity.size, 1);

  endComboRun();
  const idle = currentComboRun();
  assert.equal(idle.running, false);
  assert.equal(idle.stage, null);
  assert.equal(idle.activity.size, 0, "a finished run must not keep the core lit as if it were working");
  assert.equal(idle.pool, null);

  reportComboEvent({ type: "model", key: "saved:cfg-1:claude", status: "started" });
  assert.equal(currentComboRun().activity.size, 0, "late events after Stop cannot relight the network");
});

test("a new run does not inherit the previous run's state", () => {
  startComboRun();
  reportComboEvent({ type: "pool", active: [{ key: "a" }, { key: "b" }] });
  reportComboEvent({ type: "model", key: "a", status: "started" });
  startComboRun();
  const fresh = currentComboRun();
  assert.equal(fresh.running, true);
  assert.equal(fresh.activity.size, 0);
  assert.equal(fresh.pool, null);
  endComboRun();
});

test("events that arrive outside a run are ignored", () => {
  endComboRun();
  reportComboEvent({ type: "stage", phase: "checking", message: "Stale" });
  reportComboEvent({ type: "pool", active: [{ key: "a" }] });
  reportComboEvent({ type: "model", key: "a", status: "started" });
  const idle = currentComboRun();
  assert.equal(idle.running, false);
  assert.equal(idle.stage, null);
  assert.equal(idle.activity.size, 0);
});

test("malformed events cannot corrupt the network state", () => {
  startComboRun();
  for (const event of [null, undefined, "pool", 42, {}, { type: "pool" }, { type: "model", key: "", status: "started" }]) {
    reportComboEvent(event);
  }
  const state = currentComboRun();
  assert.equal(state.running, true);
  assert.equal(state.activity.size, 0);
  endComboRun();
});

test("the bridge carries orchestration ids only, never prompt or answer text", () => {
  startComboRun();
  reportComboEvent({ type: "pool", active: [{ key: "saved:cfg-1:claude" }] });
  reportComboEvent({ type: "delta", content: "the drafted answer text" });
  reportComboEvent({ type: "done", conversationId: "conv-1", selectedCount: 1 });
  const serialized = JSON.stringify({ ...currentComboRun(), activity: [...currentComboRun().activity] });
  assert.equal(serialized.includes("the drafted answer text"), false);
  assert.equal(serialized.includes("apiKey"), false);
  assert.equal(serialized.includes("configId"), false);
  endComboRun();
});

test("a subscriber that throws cannot break the run", () => {
  startComboRun();
  const thrown = [];
  const unsubscribe = subscribeComboRun(() => {
    throw new Error("render failed");
  });
  const { unsubscribe: unsubscribeGood } = collect();
  try {
    reportComboEvent({ type: "stage", phase: "checking", message: "Still reported" });
  } catch (error) {
    thrown.push(error);
  }
  unsubscribe();
  unsubscribeGood();
  endComboRun();
  assert.deepEqual(thrown, []);
  assert.ok(currentComboRun);
});
