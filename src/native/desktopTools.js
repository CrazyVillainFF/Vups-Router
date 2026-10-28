import { invoke } from "@tauri-apps/api/core";
import { isTauriRuntime } from "./shell.js";

export const DESKTOP_TOOL_LABELS = Object.freeze({
  get_windows_known_folder: "Finding the Windows folder",
  list_directory: "Listing a local folder",
  read_file: "Reading a local file",
  search_files: "Searching local files",
  read_file_metadata: "Reading file metadata"
});

function bridgeError(error, fallback) {
  if (typeof error === "string" && error.trim()) return error.trim();
  if (error instanceof Error && error.message) return error.message;
  return fallback;
}

function requireDesktop() {
  if (!isTauriRuntime()) {
    throw new Error("Local Windows filesystem tools are available in the VupsRouter desktop app.");
  }
}

export function desktopToolLabel(name) {
  return DESKTOP_TOOL_LABELS[name] || "Using a local filesystem tool";
}

export async function setDesktopToolPolicy({ owner, mode, workspaceId }) {
  requireDesktop();
  try {
    return await invoke("desktop_tool_set_policy", {
      input: {
        owner,
        mode,
        workspaceId: workspaceId || null
      }
    });
  } catch (error) {
    throw new Error(bridgeError(error, "Could not update the Windows filesystem permission mode."));
  }
}

export async function getDesktopToolPolicy() {
  requireDesktop();
  try {
    return await invoke("desktop_tool_policy_status");
  } catch (error) {
    throw new Error(bridgeError(error, "Could not read the Windows filesystem permission mode."));
  }
}

export async function executeDesktopTool(tool, args) {
  requireDesktop();
  try {
    return await invoke("desktop_tool_execute", {
      request: {
        tool,
        args: args && typeof args === "object" ? args : {}
      }
    });
  } catch (error) {
    throw new Error(bridgeError(error, "The Windows filesystem tool did not run."));
  }
}
