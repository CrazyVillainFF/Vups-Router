import { useCallback, useSyncExternalStore } from "react";
import {
  DEFAULT_HOME_THEME_SETTING,
  applyHomeThemeSetting,
  loadHomeThemeSetting,
  normalizeHomeThemeSetting,
  prefersDarkScheme,
  resolveHomeTheme,
  saveHomeThemeSetting
} from "./homeTheme.js";

// One cached setting plus a listener set, so the sidebar toggle, the home screen
// and Application settings all drive the same state without a context provider
// around the router.
const listeners = new Set();
let setting = null;

function store() {
  return typeof window === "undefined" ? null : window.localStorage;
}

function readSetting() {
  if (setting === null) setting = loadHomeThemeSetting(store());
  return setting;
}

function readTheme() {
  return resolveHomeTheme(readSetting(), prefersDarkScheme());
}

function subscribe(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function emit() {
  for (const listener of listeners) listener();
}

export function getHomeTheme() {
  return readTheme();
}

export function getHomeThemeSetting() {
  return readSetting();
}

export function setHomeTheme(value) {
  setting = saveHomeThemeSetting(store(), normalizeHomeThemeSetting(value));
  applyHomeThemeSetting(setting);
  emit();
  return readTheme();
}

/* Non-React callers (the WebGL scene) need the same signal the components get. */
export function subscribeHomeTheme(listener) {
  return subscribe(listener);
}

export function useHomeTheme() {
  const nextSetting = useSyncExternalStore(
    subscribe,
    readSetting,
    () => DEFAULT_HOME_THEME_SETTING
  );
  const theme = useSyncExternalStore(subscribe, readTheme, () => "dark");

  /* The sidebar sun/moon button owns the resolved look, not the tri-state: it
     flips to whichever concrete theme the product is not currently showing. */
  const toggleHomeTheme = useCallback(() => {
    setHomeTheme(readTheme() === "light" ? "dark" : "light");
  }, []);

  return { theme, setting: nextSetting, setHomeTheme, toggleHomeTheme };
}
