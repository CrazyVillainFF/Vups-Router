import { invoke } from "@tauri-apps/api/core";
import { isTauriRuntime } from "../native/shell.js";

export { isTauriRuntime };

function tauriInvoke(command, args) {
  if (!isTauriRuntime()) {
    return Promise.reject(new Error("Workspace folders are available in the Windows app."));
  }
  return invoke(command, args);
}

function bridgeError(error, fallback) {
  if (typeof error === "string" && error.trim()) return error.trim();
  if (error instanceof Error && error.message) return error.message;
  return fallback;
}

export async function listWorkspaces(owner) {
  try {
    const workspaces = await tauriInvoke("workspace_list", { owner });
    return Array.isArray(workspaces) ? workspaces : [];
  } catch (error) {
    throw new Error(bridgeError(error, "Could not load local workspaces."));
  }
}

export async function pickWorkspace(owner) {
  try {
    return await tauriInvoke("workspace_pick", { owner });
  } catch (error) {
    throw new Error(bridgeError(error, "Could not open the folder picker."));
  }
}

export async function renameWorkspace(owner, id, title) {
  try {
    return await tauriInvoke("workspace_rename", { owner, id, title });
  } catch (error) {
    throw new Error(bridgeError(error, "Could not rename the workspace."));
  }
}

export async function removeWorkspace(owner, id) {
  try {
    await tauriInvoke("workspace_remove", { owner, id });
  } catch (error) {
    throw new Error(bridgeError(error, "Could not remove the workspace."));
  }
}

export async function scanWorkspace(owner, id) {
  try {
    return await tauriInvoke("workspace_scan", { owner, id });
  } catch (error) {
    throw new Error(bridgeError(error, "Could not scan the workspace folder."));
  }
}

export async function readWorkspaceFile(owner, id, path) {
  try {
    return await tauriInvoke("workspace_read", { owner, id, path });
  } catch (error) {
    throw new Error(bridgeError(error, "Could not read this workspace file."));
  }
}
