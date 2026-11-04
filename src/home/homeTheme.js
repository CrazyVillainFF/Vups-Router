export const HOME_THEME_KEY = "vupsrouter.home.theme.v1";

/* The *setting* is system/dark/light (Application settings owns all three). The
   *resolved* theme is always dark or light, because that is what paints the
   document. Keeping them separate is what lets "System" follow the OS live
   without destroying the stored preference. */
export const HOME_THEME_SETTINGS = ["system", "dark", "light"];
export const RESOLVED_HOME_THEMES = ["dark", "light"];
export const DEFAULT_HOME_THEME_SETTING = "system";

export function normalizeHomeThemeSetting(value) {
  return HOME_THEME_SETTINGS.includes(value) ? value : DEFAULT_HOME_THEME_SETTING;
}

export function normalizeHomeTheme(value) {
  return RESOLVED_HOME_THEMES.includes(value) ? value : "dark";
}

export function loadHomeThemeSetting(storage) {
  try {
    return normalizeHomeThemeSetting(storage?.getItem(HOME_THEME_KEY));
  } catch {
    return DEFAULT_HOME_THEME_SETTING;
  }
}

export function saveHomeThemeSetting(storage, value) {
  const setting = normalizeHomeThemeSetting(value);
  try {
    storage?.setItem(HOME_THEME_KEY, setting);
  } catch {
    // A blocked storage still gets a usable theme for this session.
  }
  return setting;
}

/* Tri-state on purpose: null means "this host cannot tell us". A webview with no
   matchMedia, a blocked media query, or SSR all land there, and guessing "light"
   would flip a first-time user onto the paper palette while the stylesheet's own
   unresolved state is dark. Unknown resolves to dark, which is the default paint. */
export function prefersDarkScheme(win = typeof window === "undefined" ? null : window) {
  try {
    const media = win?.matchMedia?.("(prefers-color-scheme: dark)");
    return media ? Boolean(media.matches) : null;
  } catch {
    return null;
  }
}

export function resolveHomeTheme(setting, prefersDark = null) {
  const next = normalizeHomeThemeSetting(setting);
  if (next === "system") return prefersDark === false ? "light" : "dark";
  return next;
}

export function applyHomeTheme(theme, doc = typeof document === "undefined" ? null : document) {
  const next = normalizeHomeTheme(theme);
  try {
    doc?.documentElement?.setAttribute("data-theme", next);
  } catch {
    // No document means no shell to paint; the tokens simply stay default.
  }
  return next;
}

export function applyHomeThemeSetting(setting, win = typeof window === "undefined" ? null : window) {
  const normalized = normalizeHomeThemeSetting(setting);
  const resolved = resolveHomeTheme(normalized, prefersDarkScheme(win));
  try {
    win?.document?.documentElement?.setAttribute("data-theme-setting", normalized);
  } catch {
    // Attribute is diagnostic only; the paint comes from data-theme.
  }
  applyHomeTheme(resolved, win?.document);
  return resolved;
}

export function initHomeTheme(win = typeof window === "undefined" ? null : window) {
  const setting = loadHomeThemeSetting(win?.localStorage);
  const resolved = applyHomeThemeSetting(setting, win);
  /* System is a live dependency, not a snapshot: the OS flipping after the page
     loaded has to flip the app too, without overwriting a stored choice. */
  try {
    const media = win?.matchMedia?.("(prefers-color-scheme: dark)");
    media?.addEventListener?.("change", () => {
      if (loadHomeThemeSetting(win?.localStorage) === "system") applyHomeThemeSetting("system", win);
    });
  } catch {
    // Older engines without addEventListener simply keep the initial paint.
  }
  return resolved;
}
