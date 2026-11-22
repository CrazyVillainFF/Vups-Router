import { invoke } from "@tauri-apps/api/core";

import { isTauriRuntime } from "../native/shell.js";

/** The native hardware reading, or null when this build has no native side. */
export async function nativeHardwareInfo() {
  if (!isTauriRuntime()) return null;
  try {
    return await invoke("local_hardware_info");
  } catch {
    return null;
  }
}
