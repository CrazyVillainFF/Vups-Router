import { invoke } from "@tauri-apps/api/core";
import { isTauriRuntime } from "../native/shell.js";

function bridgeError(error, fallback) {
  if (typeof error === "string" && error.trim()) return error.trim();
  if (error instanceof Error && error.message) return error.message;
  return fallback;
}

export async function pickComposerFolder() {
  if (!isTauriRuntime()) {
    throw new Error("Folder attachments are available in the Windows app.");
  }
  try {
    return await invoke("composer_pick_folder");
  } catch (error) {
    throw new Error(bridgeError(error, "The folder picker could not open."));
  }
}

export async function releaseComposerFolder(token) {
  if (!isTauriRuntime() || !token) return;
  try {
    await invoke("composer_release_folder", { token });
  } catch {
    // The token expires with the window anyway.
  }
}

export async function readComposerFiles(token, paths) {
  if (!isTauriRuntime()) {
    throw new Error("Folder attachments are available in the Windows app.");
  }
  try {
    const result = await invoke("composer_read_files", { token, paths });
    return Array.isArray(result) ? result : [];
  } catch (error) {
    throw new Error(bridgeError(error, "The folder contents could not be read."));
  }
}
