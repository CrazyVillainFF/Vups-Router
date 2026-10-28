import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import {
  HOLD_TO_DELETE_MS,
  formatHoldSeconds,
  holdProgress,
  holdReached
} from "../src/components/holdToDelete.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = file => readFileSync(path.join(root, file), "utf8");

test("hold-to-delete timing is deliberate and bounded", () => {
  assert.ok(HOLD_TO_DELETE_MS >= 1500);
  assert.ok(HOLD_TO_DELETE_MS <= 2000);
  assert.equal(formatHoldSeconds(HOLD_TO_DELETE_MS), "1.6");
  assert.equal(formatHoldSeconds(2000), "2");
});

test("hold progress clamps and reports completion only after the full hold", () => {
  assert.equal(holdProgress(1000, 1000), 0);
  assert.equal(holdProgress(1000, 1800), 0.5);
  assert.equal(holdProgress(1000, 2600), 1);
  assert.equal(holdProgress(1000, 4000), 1);
  assert.equal(holdProgress(Number.NaN, 1800), 0);
  assert.equal(holdReached(1000, 2599), false);
  assert.equal(holdReached(1000, 2600), true);
  assert.equal(holdReached(1000, 4000), true);
});

test("hold-to-delete button cancels on release, cancel, blur, and focus loss", () => {
  const button = read("src/components/HoldToDeleteButton.jsx");
  assert.match(button, /onPointerDown=/);
  assert.match(button, /onPointerUp=/);
  assert.match(button, /onPointerCancel=/);
  assert.match(button, /onLostPointerCapture=/);
  assert.match(button, /onPointerLeave=\{cancel\}/);
  assert.match(button, /onBlur=\{cancel\}/);
  assert.match(button, /onKeyDown=/);
  assert.match(button, /onKeyUp=/);
  assert.match(button, /requestAnimationFrame/);
  assert.match(button, /resetKey/);
  assert.match(button, /aria-live="polite"/);
});

test("hold-to-delete dialog names the item, shows errors, and offers keyboard confirmation", () => {
  const dialog = read("src/components/HoldToDeleteDialog.jsx");
  assert.match(dialog, /role="alertdialog"/);
  assert.match(dialog, /aria-modal="true"/);
  assert.match(dialog, /aria-busy=/);
  assert.match(dialog, /role="alert"/);
  assert.match(dialog, /role="status"/);
  assert.match(dialog, /Selected item/);
  assert.match(dialog, /Keyboard or screen reader confirmation/);
  assert.match(dialog, /Delete permanently/);
  assert.match(dialog, /event\.key !== "Tab"/);
  assert.match(dialog, /if \(!busyRef\.current\) onCancel/);
});

test("all permanent delete surfaces use the shared hold confirmation", () => {
  const chat = read("src/ChatPage.jsx");
  const sidebar = read("src/desktop/DesktopSidebar.jsx");
  const settings = read("src/SettingsPage.jsx");
  const pages = read("src/desktop/DesktopPages.jsx");
  const workspaces = read("src/desktop/WorkspaceManagerDialog.jsx");
  assert.match(chat, /onDeleteModel=\{requestDeleteModel\}/);
  assert.match(chat, /<HoldToDeleteDialog/);
  assert.match(sidebar, /<HoldToDeleteDialog/);
  assert.match(settings, /<HoldToDeleteDialog/);
  assert.match(pages, /<HoldToDeleteDialog/);
  assert.match(workspaces, /<HoldToDeleteDialog/);
  assert.doesNotMatch(sidebar, /window\.confirm/);
  assert.doesNotMatch(pages, /window\.confirm/);
  assert.doesNotMatch(workspaces, /window\.confirm/);
  assert.doesNotMatch(chat, /window\.confirm/);
  assert.equal((settings.match(/window\.confirm/g) || []).length, 2);
});
