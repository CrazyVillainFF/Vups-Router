const PLUGIN_NAME = "VupsDownloads";

export function androidDownloadsPlugin() {
  if (typeof window === "undefined") return null;
  const capacitor = window.Capacitor;
  if (!capacitor?.isNativePlatform?.()) return null;
  if (capacitor.getPlatform?.() !== "android") return null;
  return capacitor.Plugins?.[PLUGIN_NAME] ?? null;
}

export function isAndroidDownloadsAvailable() {
  return Boolean(androidDownloadsPlugin());
}

export async function blobToBase64(blob) {
  if (!blob || typeof blob.arrayBuffer !== "function") {
    throw new Error("This file cannot be downloaded on Android.");
  }
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let binary = "";
  const chunk = 0x8000;
  for (let index = 0; index < bytes.length; index += chunk) {
    binary += String.fromCharCode(...bytes.subarray(index, index + chunk));
  }
  return btoa(binary);
}

/** Returns a promise only when the native bridge exists; web stays synchronous. */
export function saveBlobToAndroid(blob, filename) {
  const plugin = androidDownloadsPlugin();
  if (!plugin?.saveBlob) return null;
  return (async () => {
    const base64 = await blobToBase64(blob);
    const result = await plugin.saveBlob({
      base64,
      filename: String(filename || "download"),
      mimeType: blob?.type || "application/octet-stream"
    });
    return result?.id || null;
  })();
}

export async function enqueueAndroidDownload({ url, filename, mimeType } = {}) {
  const plugin = androidDownloadsPlugin();
  if (!plugin?.enqueue) throw new Error("Downloads are not available in this app.");
  return plugin.enqueue({ url, filename, mimeType });
}

export async function listAndroidDownloads() {
  const plugin = androidDownloadsPlugin();
  if (!plugin?.list) return [];
  const result = await plugin.list();
  return Array.isArray(result?.downloads) ? result.downloads : [];
}

export async function cancelAndroidDownload(id) {
  const plugin = androidDownloadsPlugin();
  if (!plugin?.cancel) return;
  await plugin.cancel({ id });
}

export async function retryAndroidDownload(id) {
  const plugin = androidDownloadsPlugin();
  if (!plugin?.retry) return;
  await plugin.retry({ id });
}

export async function openAndroidDownload(id) {
  const plugin = androidDownloadsPlugin();
  if (!plugin?.openFile) return;
  await plugin.openFile({ id });
}

export async function clearFinishedAndroidDownloads() {
  const plugin = androidDownloadsPlugin();
  if (!plugin?.clearFinished) return;
  await plugin.clearFinished();
}

export async function androidNotificationsStatus() {
  const plugin = androidDownloadsPlugin();
  if (!plugin?.notificationsStatus) return { granted: true, canRequest: false, enabled: true };
  return plugin.notificationsStatus();
}

export async function requestAndroidNotifications() {
  const plugin = androidDownloadsPlugin();
  if (!plugin?.requestNotifications) return { granted: true, canRequest: false, enabled: true };
  return plugin.requestNotifications();
}

export function subscribeAndroidDownloadEvents(callback) {
  const plugin = androidDownloadsPlugin();
  if (!plugin?.addListener || typeof callback !== "function") return () => {};
  let handle = null;
  let removed = false;
  try {
    const pending = plugin.addListener("download", callback);
    if (pending?.then) {
      pending
        .then(result => {
          if (removed) result?.remove?.();
          else handle = result;
        })
        .catch(() => {});
    } else {
      handle = pending;
    }
  } catch {
    return () => {};
  }
  return () => {
    removed = true;
    try {
      handle?.remove?.();
    } catch {
      /* the bridge may already be gone */
    }
  };
}
