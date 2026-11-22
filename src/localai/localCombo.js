/**
 * Local Combo AI configuration.
 *
 * This is the device-side combo, independent from the cloud Vups Combo AI:
 * it has its own storage key, its own model list and its own runner, and it
 * only ever calls the local runtime.
 */

import { useSyncExternalStore } from "react";

export const LOCAL_COMBO_STORAGE_KEY = "vupsrouter.localcombo.v1";

const listeners = new Set();
let cached = null;

function browserStorage() {
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

export function normalizeComboConfig(raw) {
  const models = [];
  const seen = new Set();
  for (const value of Array.isArray(raw?.models) ? raw.models : []) {
    const name = String(value || "").trim();
    if (!name || seen.has(name.toLowerCase())) continue;
    seen.add(name.toLowerCase());
    models.push(name);
  }
  return {
    enabled: Boolean(raw?.enabled),
    models,
    updatedAt: typeof raw?.updatedAt === "string" ? raw.updatedAt : ""
  };
}

export function readLocalComboConfig(storage = browserStorage()) {
  try {
    const parsed = JSON.parse(storage?.getItem(LOCAL_COMBO_STORAGE_KEY) || "null");
    return normalizeComboConfig(parsed);
  } catch {
    return normalizeComboConfig(null);
  }
}

export function writeLocalComboConfig(next, storage = browserStorage()) {
  const config = normalizeComboConfig({ ...next, updatedAt: new Date().toISOString() });
  try {
    storage?.setItem(LOCAL_COMBO_STORAGE_KEY, JSON.stringify(config));
  } catch {
    /* The page keeps the live config even when the device cannot store it. */
  }
  cached = config;
  listeners.forEach(listener => listener());
  return config;
}

function subscribe(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function snapshot() {
  if (!cached) cached = readLocalComboConfig();
  return cached;
}

/**
 * Apply a change to the configuration as it is stored right now.
 *
 * A handler that spreads the config it rendered with loses any change made
 * between that render and the click (two quick selections would undo each
 * other), so every change is merged against the latest known config instead.
 */
export function updateLocalComboConfig(updater, storage = browserStorage()) {
  const current = snapshot();
  const next = typeof updater === "function" ? updater(current) : { ...current, ...updater };
  return writeLocalComboConfig(next, storage);
}

export function resetLocalComboCache() {
  cached = null;
}

export function useLocalComboConfig() {
  return useSyncExternalStore(subscribe, snapshot, snapshot);
}

/**
 * Which selected models are actually installed right now.
 *
 * A selection whose model was removed is reported as missing instead of being
 * silently dropped: the page can tell the reader what will not run.
 */
export function comboPlan(config, installedModels) {
  const installedByName = new Map(
    (Array.isArray(installedModels) ? installedModels : [])
      .map(model => [String(model?.name || model?.model || "").toLowerCase(), String(model?.name || model?.model || "")])
      .filter(([key]) => Boolean(key))
  );
  const selected = normalizeComboConfig(config).models;
  const usable = [];
  const missing = [];
  for (const name of selected) {
    const runtimeName = installedByName.get(name.toLowerCase());
    if (runtimeName) usable.push(runtimeName);
    else missing.push(name);
  }
  return { selected, usable, missing };
}

export function modelLabel(name) {
  return String(name || "").replace(/:latest$/i, "");
}
