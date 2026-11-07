import { invoke } from "@tauri-apps/api/core";
import { isTauriRuntime } from "../native/shell.js";

export { isTauriRuntime };

function tauriInvoke(command, args) {
  if (!isTauriRuntime()) {
    return Promise.reject(new Error("Skill packages are managed by the Windows app."));
  }
  return invoke(command, args);
}

// The skills engine answers a failure with { code, message }, not with a bare
// string like the folder commands do. The reason the engine gave is the only
// thing that tells the user which package to fix, so it has to survive here.
function failureText(error, fallback) {
  if (typeof error === "string" && error.trim()) return error.trim();
  if (error instanceof Error && error.message) return error.message;
  if (error && typeof error === "object") {
    const message = typeof error.message === "string" ? error.message.trim() : "";
    const code = typeof error.code === "string" ? error.code.trim() : "";
    if (message && code) return `${message} (${code})`;
    if (message) return message;
    if (code) return code;
  }
  return fallback;
}

function statusOrThrow(error, fallback) {
  throw new Error(failureText(error, fallback));
}

/** The Skills folder exactly as the engine resolved it, with every package read. */
export async function readSkills() {
  try {
    return await tauriInvoke("skills_status", {});
  } catch (error) {
    statusOrThrow(error, "Could not read the Skills folder.");
  }
}

/** Re-reads and re-validates the folder. It changes no package. */
export async function rescanSkills() {
  try {
    return await tauriInvoke("skills_scan", {});
  } catch (error) {
    statusOrThrow(error, "Could not re-scan the Skills folder.");
  }
}

/** Asks Windows for a package path. Empty means the user cancelled, not a failure. */
export async function pickSkillSource({ archive = false } = {}) {
  try {
    const chosen = await tauriInvoke("skills_pick_source", { archive: archive === true });
    return typeof chosen === "string" && chosen.trim() ? chosen.trim() : "";
  } catch (error) {
    statusOrThrow(error, "Could not open the package picker.");
  }
}

/**
 * Stages, validates and installs one package. A package the engine rejects
 * never reaches the Skills folder, so the error this throws is the reason the
 * folder still holds what it held before.
 */
export async function installSkill(source, { overwrite = false } = {}) {
  const path = typeof source === "string" ? source.trim() : "";
  try {
    return await tauriInvoke("skills_install", { source: path, overwrite: overwrite === true });
  } catch (error) {
    statusOrThrow(error, "Could not install the skill package.");
  }
}

export async function uninstallSkill(id) {
  try {
    return await tauriInvoke("skills_uninstall", { id: String(id || "").trim() });
  } catch (error) {
    statusOrThrow(error, "Could not remove the skill package.");
  }
}

/** The engine keeps the switch in its own state file, so it survives a restart. */
export async function setSkillEnabled(id, enabled) {
  try {
    return await tauriInvoke("skills_set_enabled", {
      id: String(id || "").trim(),
      enabled: enabled === true
    });
  } catch (error) {
    statusOrThrow(error, "Could not change the skill switch.");
  }
}
