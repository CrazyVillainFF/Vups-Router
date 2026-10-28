import React, { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import {
  DEFAULT_PREFERENCES,
  loadPreferences,
  savePreferences,
  updatePreference
} from "./preferences.js";

const PreferencesContext = createContext(null);

function browserStorage() {
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

export function PreferencesProvider({ children }) {
  const [preferences, setPreferences] = useState(() => loadPreferences(browserStorage()));

  const update = useCallback((key, value) => {
    setPreferences(current => savePreferences(browserStorage(), updatePreference(current, key, value)));
  }, []);

  const reset = useCallback(() => {
    setPreferences(savePreferences(browserStorage(), DEFAULT_PREFERENCES));
  }, []);

  useEffect(() => {
    document.documentElement.dataset.reduceMotion = preferences.reducedMotion ? "true" : "false";
  }, [preferences.reducedMotion]);

  const value = useMemo(
    () => ({ preferences, update, reset }),
    [preferences, update, reset]
  );

  return <PreferencesContext.Provider value={value}>{children}</PreferencesContext.Provider>;
}

export function usePreferences() {
  const context = useContext(PreferencesContext);
  if (!context) throw new Error("usePreferences must be used inside a PreferencesProvider.");
  return context;
}
