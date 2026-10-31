const PLUGIN_NAME = "VupsAppInfo";

function capacitorAndroid() {
  if (typeof window === "undefined") return null;
  const capacitor = window.Capacitor;
  if (!capacitor?.isNativePlatform?.()) return null;
  if (capacitor.getPlatform?.() !== "android") return null;
  return capacitor;
}

/** True inside the Android shell even before the info plugin ships in an APK. */
export function isAndroidApp() {
  return Boolean(capacitorAndroid());
}

export function appInfoPlugin() {
  return capacitorAndroid()?.Plugins?.[PLUGIN_NAME] ?? null;
}

export function isTauriApp() {
  return typeof window !== "undefined" && Boolean(window.__TAURI_INTERNALS__);
}

export async function installedAppInfo() {
  if (isTauriApp()) {
    try {
      const { getVersion } = await import("@tauri-apps/api/app");
      return {
        platform: "windows",
        version: String((await getVersion()) || ""),
        build: "",
        packageId: "com.vupsrouter.desktop"
      };
    } catch {
      return { platform: "windows", version: "", build: "", packageId: "com.vupsrouter.desktop" };
    }
  }
  const plugin = appInfoPlugin();
  if (plugin?.info) {
    try {
      const info = await plugin.info();
      return {
        platform: "android",
        version: String(info?.version || ""),
        build: String(info?.build ?? ""),
        packageId: String(info?.packageId || "com.vupsrouter.app")
      };
    } catch {
      return { platform: "android", version: "", build: "", packageId: "com.vupsrouter.app" };
    }
  }
  // Older APKs already installed have no info plugin; still name the runtime
  // correctly so the UI never reports the Android app as a web page.
  if (isAndroidApp()) {
    return { platform: "android", version: "", build: "", packageId: "com.vupsrouter.app" };
  }
  return { platform: "web", version: "", build: "", packageId: "" };
}

/**
 * Hands a fully downloaded APK to Android's own installer after the native
 * plugin has checked the package id, the signing certificate, and the version
 * code. The system prompt is still the only thing that installs anything.
 */
export async function installAndroidUpdate(downloadId) {
  const plugin = appInfoPlugin();
  if (!plugin?.installUpdate) {
    throw new Error("Updates can only be installed from the Android app.");
  }
  return plugin.installUpdate({ id: String(downloadId || "") });
}
