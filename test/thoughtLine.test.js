import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { measuredSeconds } from "../src/chat/activity.js";

const read = path => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

test("elapsed seconds come from real turn timestamps", () => {
  assert.equal(measuredSeconds({ startedAt: 1000, now: 12500 }), 11.5);
  assert.equal(measuredSeconds({ startedAt: 1000, endedAt: 3500 }), 2.5);
  assert.equal(measuredSeconds({ startedAt: 1000, endedAt: 3500, now: 9000 }), 2.5);
  assert.equal(measuredSeconds({ startedAt: null, now: 9000 }), null);
  assert.equal(measuredSeconds({ startedAt: 5000, now: 4000 }), null);
  assert.equal(measuredSeconds(), null);
});

test("ThoughtLine is restored from the existing React Bits component", () => {
  const component = read("src/components/reactbits/ThoughtLine.jsx");
  assert.match(component, /from 'motion\/react'/);
  assert.match(component, /useReducedMotion\(\)/);
  assert.match(component, /working = true/);
  assert.match(component, /showTimer = true/);
  assert.match(component, /onSettle/);
  assert.match(component, /if \(elapsed != null\)/);
  assert.match(component, /setInterval\(\(\) => \{/);
  assert.match(component, /clearInterval\(id\)/);
});

test("AgentActivity uses ThoughtLine as the single thinking indicator and timer", () => {
  const agent = read("src/components/AgentActivity.jsx");
  assert.match(agent, /import ThoughtLine from "\.\/reactbits\/ThoughtLine\.jsx";/);
  assert.match(agent, /<ThoughtLine/);
  assert.match(agent, /working=\{active\}/);
  assert.match(agent, /label=\{stateLabel\}/);
  assert.match(agent, /doneLabel=\{doneLabel\}/);
  assert.match(agent, /elapsed=\{elapsedSeconds\}/);
  assert.match(agent, /showTimer/);
  assert.match(agent, /glyph="sparkle"/);
  assert.match(agent, /color=\{active \? "var\(--accent\)" : "#c7d2e3"\}/);
  assert.doesNotMatch(agent, /color="currentColor"/);
  assert.match(agent, /collapsible=\{false\}/);
  assert.match(agent, /measuredSeconds\(/);
  assert.doesNotMatch(agent, /vr-activity__elapsed/);
  assert.doesNotMatch(agent, /chain of thought|hidden reasoning|reasoning steps/i);
});

test("the assistant message keeps the real event timeline beside the thinking line", () => {
  const agent = read("src/components/AgentActivity.jsx");
  const page = read("src/ChatPage.jsx");
  assert.match(agent, /mergeActivityFiles\(events, files\)/);
  assert.match(agent, /className="vr-activity__list"/);
  assert.match(agent, /aria-expanded=\{open\}/);
  assert.match(agent, /aria-controls=\{panelId\}/);
  assert.match(page, /<AgentActivity/);
  assert.match(page, /events=\{message\.activity \|\| \[\]\}/);
  assert.match(page, /startedAt=\{message\.startedAt\}/);
  assert.match(page, /completedAt=\{message\.completedAt\}/);
  // One timer only: ThoughtLine lives inside AgentActivity, never in the message body.
  assert.equal((page.match(/<ThoughtLine/g) || []).length, 0);
});

test("the shimmer gradient keeps the working label visible", () => {
  const css = read("src/components/reactbits/ThoughtLine.css");
  const rule = css.match(/\.thought-line\[data-working\][^{]*\.thought-line__breath[^{]*\{[^}]*\}/s)?.[0] || "";
  assert.match(rule, /-webkit-text-fill-color:\s*transparent/);
  assert.doesNotMatch(rule, /(^|\n)\s*color:\s*transparent/);
  assert.match(rule, /currentColor|var\(--tl-color\)/);
});

test("the live timeline opens while the turn runs and folds after it settles", () => {
  const agent = read("src/components/AgentActivity.jsx");
  assert.match(agent, /const \[open, setOpen\] = useState\(active\)/);
  assert.match(agent, /const \[userToggled, setUserToggled\] = useState\(false\)/);
  assert.match(agent, /const ranLiveRef = useRef\(active\)/);
  assert.match(agent, /ranLiveRef\.current = true;\s*setOpen\(true\)/);
  assert.match(
    agent,
    /shouldAutoCollapseActivity\(\{\s*active,\s*status,\s*userToggled,\s*ranLive: ranLiveRef\.current\s*\}\)/
  );
  assert.match(agent, /setTimeout\(\(\) => setOpen\(false\), ACTIVITY_COLLAPSE_HOLD_MS\)/);
  assert.match(agent, /return \(\) => clearTimeout\(timer\)/);
  assert.doesNotMatch(agent, /pinned/);
});

test("thinking labels come from the real stream phase", () => {
  const progress = read("src/chat/progress.js");
  const agent = read("src/components/AgentActivity.jsx");
  assert.match(progress, /label: current\?\.label \|\| PROGRESS_FALLBACK_LABEL/);
  assert.match(agent, /const progress = useMemo\(/);
  assert.match(agent, /progress\?\.label/);
});
