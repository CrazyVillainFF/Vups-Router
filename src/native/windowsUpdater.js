import { isTauriApp } from "./appInfo.js";

// The Windows shell updates itself through the Tauri updater plugin, which
// reads the signed manifest published next to the installers on GitHub
// Releases. Nothing here runs outside the Tauri runtime, and the plugin modules
// are only imported once we know we are inside it.

let dependencyOverride = null;

// Test seam only: production leaves this null and loads the real Tauri plugins.
export function __setWindowsUpdaterDepsForTest(deps) {
  dependencyOverride = deps || null;
}

async function loadDeps() {
  if (dependencyOverride) return dependencyOverride;
  const [updater, processModule] = await Promise.all([
    import("@tauri-apps/plugin-updater"),
    import("@tauri-apps/plugin-process")
  ]);
  return { updater, process: processModule };
}

export function isWindowsUpdaterAvailable() {
  return isTauriApp();
}

export function updaterErrorMessage(error) {
  const message = String(error?.message || error || "");
  if (/timed?\s*out|timeout/i.test(message)) {
    return "The update service took too long to respond. Try again.";
  }
  if (/invalid signature|signature|pubkey|verif/i.test(message)) {
    return "The published update could not be verified, so it was not installed.";
  }
  if (
    /failed to (fetch|connect|download)|network|sending request|request for url|error sending/i.test(
      message
    )
  ) {
    return "Unable to reach the update service. Check your connection and try again.";
  }
  if (/not found|\b4\d\d\b|\b5\d\d\b|status code|responded/i.test(message)) {
    return "The update service is unavailable right now. Try again later.";
  }
  return message || "The update could not be checked right now.";
}

export function createUpdaterProgress() {
  let total = -1;
  let received = 0;
  return function handle(event) {
    switch (event?.event) {
      case "Started":
        if (Number.isFinite(event?.data?.contentLength)) total = event.data.contentLength;
        break;
      case "Progress":
        received += Number(event?.data?.chunkLength) || 0;
        break;
      case "Finished":
        if (total < 0) total = received;
        break;
      default:
        break;
    }
    const percent =
      total > 0 ? Math.min(100, Math.round((received / total) * 100)) : null;
    return { received, total: total > 0 ? total : null, percent };
  };
}

function normalize(update) {
  return {
    version: String(update?.version || ""),
    date: update?.date || "",
    notes: update?.body || "",
    async downloadAndInstall(onEvent) {
      // The app stays open after a passive install; the UI offers the restart
      // once the installer has run, so the user is never surprised by a close.
      await update.downloadAndInstall(onEvent, { restartAfterInstall: false });
    },
    close() {
      return update.close ? update.close() : Promise.resolve();
    }
  };
}

export async function checkWindowsUpdate() {
  const { updater } = await loadDeps();
  const update = await updater.check();
  return update ? normalize(update) : null;
}

export async function restartWindowsApp() {
  const { process: processModule } = await loadDeps();
  await processModule.relaunch();
}
