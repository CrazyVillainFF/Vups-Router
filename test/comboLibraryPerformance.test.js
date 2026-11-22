/**
 * The Combo AI model library: a page that browses fast and checks in a
 * controlled way.
 *
 * Two things are pinned here. The library draws a page of models at a time and
 * scrolls inside its own panel, so a thousand models never turn into a
 * thousand rows or a page taller than the screen. And every availability check
 * the page starts goes through one queue with a hard ceiling, so the provider
 * is never asked more than ten questions at a time.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = relative => readFileSync(path.join(root, relative), "utf8");
const comboPage = read("src/combo/ComboPage.jsx");
const comboCss = read("src/combo/combo.css");
const comboSelection = read("src/combo/modelCheckQueue.js");

test("the library scrolls inside its own panel", () => {
  // A row that grows with the list makes the whole page taller than the
  // screen, and only two models are ever in view. The grid row is bounded
  // instead, and the list does the scrolling.
  assert.match(comboCss, /\.combo-layout \{[\s\S]*?grid-template-rows: minmax\(0, 1fr\);/);
  assert.match(comboCss, /\.combo-panel \{[\s\S]*?overflow: hidden;/);
  assert.match(comboCss, /\.combo-list \{[\s\S]*?overflow-y: auto;/);
});

test("the rows are compact enough to show many models at once", () => {
  assert.match(comboCss, /\.combo-row \{[\s\S]*?min-height: 34px;/);
  assert.match(comboCss, /\.combo-row \{[\s\S]*?padding: 3px 6px;/);
});

test("the page draws a page of models, never the whole library", () => {
  assert.match(comboPage, /const LIBRARY_PAGE_SIZE = 100;/);
  assert.match(comboPage, /const visibleModels = filtered\.slice\(0, LIBRARY_PAGE_SIZE\);/);
  assert.match(comboPage, /\{visibleModels\.map\(model => \{/);
  assert.ok(!/\{filtered\.map\(model => \{/.test(comboPage), "the whole library is never drawn");
});

test("every availability check goes through one queue with a ceiling of ten", () => {
  assert.match(comboPage, /concurrency: MODEL_CHECK_CONCURRENCY/);
  assert.match(comboPage, /createModelCheckQueue\(\{/);
  // A model checked by hand and the whole-library sweep share that queue.
  assert.match(comboPage, /function testModel\(model\)[\s\S]*?checkQueueRef\.current\.enqueue\(/);
  assert.match(comboPage, /function testAll\(\)[\s\S]*?checkQueueRef\.current\.enqueue\(/);
  assert.match(comboPage, /function recheckSelected\(\)[\s\S]*?checkQueueRef\.current\.enqueue\(/);
});

test("the queue caps the probes and protects the provider", () => {
  assert.match(comboSelection, /export const MODEL_CHECK_CONCURRENCY = 10;/);
  assert.match(comboSelection, /Math\.max\(1, Number\(concurrency\) \|\| 1\)/);
  assert.match(comboSelection, /while \(!cancelled && active\.size < limit && pending\.length > 0\)/);
  // A model is never asked about twice.
  assert.match(comboSelection, /if \(!key \|\| queued\.has\(key\)\) continue;/);
});

test("a rate limit is retried, a refused request is not", () => {
  assert.match(comboPage, /status === 429 \|\| status >= 500/);
  assert.match(comboSelection, /if \(attempt < maxRetries && isRetryable\(error, attempt\)\)/);
  assert.match(comboSelection, /export const MODEL_CHECK_MAX_RETRIES = 3;/);
});

test("a cancelled check is not a failure", () => {
  assert.match(comboSelection, /if \(cancelled \|\| job\.cancelled\)/);
  assert.match(comboSelection, /cancelKey\(key\)/);
});

test("the queue is stopped when the page is left", () => {
  assert.match(comboPage, /checkQueueRef\.current\?\.cancel\(\);/);
});

test("the redundant explanations are gone", () => {
  assert.ok(
    !/Selected models stay saved even when unavailable/.test(comboPage),
    "the repeated description is gone"
  );
  assert.ok(!/combo-panel__desc/.test(comboPage), "and so is its element");
});

test("the counts that matter are still shown", () => {
  const summary = comboPage.slice(
    comboPage.indexOf('className="combo-summary"'),
    comboPage.indexOf('className="combo-search"')
  );
  assert.match(summary, /data-state="total"/, "the library size");
  assert.match(summary, /data-state="selected"/, "the selected count");
  assert.match(summary, /data-state="working"/, "the working count");
  assert.match(summary, /data-state="not_working"/, "the not working count");
  assert.match(summary, /data-state="unknown"/, "the not checked count");
});

test("the progress is compact and counts what is happening", () => {
  assert.match(comboPage, /Checked \$\{checkProgress\.completed\.toLocaleString\(\)\} of/);
  assert.match(comboPage, /Working: \{librarySummary\.working\.toLocaleString\(\)\}/);
  assert.match(comboPage, /Checking: \{checkProgress\.active\.toLocaleString\(\)\}/);
  assert.match(comboPage, /Not Checked: \{librarySummary\.unknown\.toLocaleString\(\)\}/);
});
