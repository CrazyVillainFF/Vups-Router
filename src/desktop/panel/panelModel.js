export const PANEL_TABS = Object.freeze([
  Object.freeze({ id: "files", label: "Workspace Files" }),
  Object.freeze({ id: "review", label: "Code Review" }),
  Object.freeze({ id: "terminal", label: "Terminal" }),
  Object.freeze({ id: "browser", label: "Browser" }),
  Object.freeze({ id: "side-task", label: "Side Task" })
]);

export const DEFAULT_TAB = "files";
export const PANEL_MIN_WIDTH = 360;
export const PANEL_MAX_WIDTH = 820;
export const PANEL_DEFAULT_WIDTH = 460;

const STATE_KEY = "vupsrouter.desktop.workspace-panel.v1";

export function isPanelTab(id) {
  return PANEL_TABS.some(tab => tab.id === id);
}

export function clampPanelWidth(width, viewportWidth) {
  const numeric = Number(width);
  if (!Number.isFinite(numeric)) return PANEL_DEFAULT_WIDTH;
  const view = Number.isFinite(Number(viewportWidth)) ? Number(viewportWidth) : 1600;
  const upper = Math.max(PANEL_MIN_WIDTH, Math.min(PANEL_MAX_WIDTH, Math.floor(view * 0.66)));
  return Math.round(Math.min(Math.max(numeric, PANEL_MIN_WIDTH), upper));
}

function sanitize(state) {
  const open = Boolean(state?.open);
  const activeTab = isPanelTab(state?.activeTab) ? state.activeTab : DEFAULT_TAB;
  const width = clampPanelWidth(state?.width ?? PANEL_DEFAULT_WIDTH);
  return { open, activeTab, width };
}

function storage(area) {
  if (!area) return null;
  try {
    return area.getItem(STATE_KEY);
  } catch {
    return null;
  }
}

export function readPanelState(area) {
  const raw = storage(area);
  if (!raw) return sanitize({ open: false, activeTab: DEFAULT_TAB, width: PANEL_DEFAULT_WIDTH });
  try {
    return sanitize(JSON.parse(raw));
  } catch {
    return sanitize({ open: false, activeTab: DEFAULT_TAB, width: PANEL_DEFAULT_WIDTH });
  }
}

export function writePanelState(area, state) {
  if (!area) return;
  try {
    area.setItem(STATE_KEY, JSON.stringify(sanitize(state)));
  } catch {
    /* persistence is best-effort and must never break the panel */
  }
}

// The native browser child-webview is positioned by window-relative logical
// pixels. A DOMRect from getBoundingClientRect() is already in those units, so
// it maps straight across; only visibility is driven by which tab is showing.
export function toBrowserBounds(rect, visible) {
  return {
    x: Math.round(rect.left),
    y: Math.round(rect.top),
    width: Math.max(1, Math.round(rect.width)),
    height: Math.max(1, Math.round(rect.height)),
    visible: Boolean(visible)
  };
}
