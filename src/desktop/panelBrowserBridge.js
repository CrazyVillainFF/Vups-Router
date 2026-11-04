import { invoke } from "@tauri-apps/api/core";
import { isTauriRuntime } from "../native/shell.js";

export { isTauriRuntime };

const NOT_AVAILABLE = "The panel browser is available in the Windows app.";

function call(command, args) {
  if (!isTauriRuntime()) return Promise.reject(new Error(NOT_AVAILABLE));
  return invoke(command, args);
}

function fail(error, fallback) {
  if (typeof error === "string" && error.trim()) return new Error(error.trim());
  if (error instanceof Error && error.message) return error;
  return new Error(fallback);
}

async function run(command, args, fallback) {
  try {
    return await call(command, args);
  } catch (error) {
    throw fail(error, fallback);
  }
}

export function createBrowserTab(tabId, url, bounds) {
  return run("panel_browser_create", { tabId, url, bounds }, "Could not open the page.");
}

export function setBrowserBounds(tabId, bounds) {
  return run("panel_browser_set_bounds", { tabId, bounds }, "Could not resize the page.");
}

export function navigateBrowserTab(tabId, url) {
  return run("panel_browser_navigate", { tabId, url }, "Could not open that page.");
}

export function browserGoBack(tabId) {
  return run("panel_browser_back", { tabId }, "The page could not go back.");
}

export function browserGoForward(tabId) {
  return run("panel_browser_forward", { tabId }, "The page could not go forward.");
}

export function browserReload(tabId) {
  return run("panel_browser_reload", { tabId }, "The page could not reload.");
}

export function browserStatus(tabId) {
  return run("panel_browser_status", { tabId }, "Could not read the page status.");
}

export function browserInspect(tabId) {
  return run("panel_browser_inspect", { tabId }, "Could not inspect the page.");
}

export function browserClick(tabId, selector) {
  return run("panel_browser_click", { tabId, selector }, "That element could not be clicked.");
}

export function browserType(tabId, selector, text, submit) {
  return run("panel_browser_type", { tabId, input: { selector, text, submit } }, "Text could not be entered.");
}

export function browserScroll(tabId, selector, deltaY) {
  return run("panel_browser_scroll", { tabId, selector, deltaY }, "The page could not be scrolled.");
}

export function browserScreenshot(tabId, x, y, width, height) {
  return run("panel_browser_screenshot", { tabId, x, y, width, height }, "The page could not be captured.");
}

export function closeBrowserTab(tabId) {
  return run("panel_browser_close", { tabId }, "That browser tab could not be closed.");
}

export function closeAllBrowserTabs() {
  return run("panel_browser_close_all", {}, "The browser tabs could not be closed.");
}
