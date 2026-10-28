export const PREFERENCES_STORAGE_KEY = "vupsrouter.desktop.preferences.v1";

export const DEFAULT_PREFERENCES = Object.freeze({
  sendShortcut: "enter",
  showTaskTimestamps: true,
  startSidebarCollapsed: false,
  reducedMotion: false
});

const SEND_SHORTCUTS = new Set(["enter", "modifier"]);

export function normalizePreferences(value) {
  const source = value && typeof value === "object" ? value : {};
  return {
    sendShortcut: SEND_SHORTCUTS.has(source.sendShortcut)
      ? source.sendShortcut
      : DEFAULT_PREFERENCES.sendShortcut,
    showTaskTimestamps:
      typeof source.showTaskTimestamps === "boolean"
        ? source.showTaskTimestamps
        : DEFAULT_PREFERENCES.showTaskTimestamps,
    startSidebarCollapsed:
      typeof source.startSidebarCollapsed === "boolean"
        ? source.startSidebarCollapsed
        : DEFAULT_PREFERENCES.startSidebarCollapsed,
    reducedMotion:
      typeof source.reducedMotion === "boolean"
        ? source.reducedMotion
        : DEFAULT_PREFERENCES.reducedMotion
  };
}

export function loadPreferences(storage) {
  if (!storage) return { ...DEFAULT_PREFERENCES };
  try {
    const stored = storage.getItem(PREFERENCES_STORAGE_KEY);
    return normalizePreferences(stored ? JSON.parse(stored) : null);
  } catch {
    return { ...DEFAULT_PREFERENCES };
  }
}

export function savePreferences(storage, preferences) {
  const normalized = normalizePreferences(preferences);
  if (storage) {
    try {
      storage.setItem(PREFERENCES_STORAGE_KEY, JSON.stringify(normalized));
    } catch {
      /* storage is best-effort */
    }
  }
  return normalized;
}

export function updatePreference(preferences, key, value) {
  return normalizePreferences({ ...preferences, [key]: value });
}
