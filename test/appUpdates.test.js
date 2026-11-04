import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, test } from "node:test";

import {
  RELEASES_PAGE_URL,
  checkLatestRelease,
  compareVersions,
  displayVersion,
  isOfficialAssetUrl,
  parseVersion,
  releaseDate,
  releaseNotes,
  releaseVersion,
  selectUpdateAsset,
  updateAvailability,
  updateErrorMessage
} from "../src/update/appUpdates.js";
import {
  appInfoPlugin,
  installedAppInfo,
  isAndroidApp,
  isTauriApp
} from "../src/native/appInfo.js";
import { createUpdaterProgress, updaterErrorMessage } from "../src/native/windowsUpdater.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = file => readFileSync(path.join(root, file), "utf8");
const androidRoot = "android/app/src/main";

const release = {
  tag_name: "v1.0.9",
  published_at: "2026-10-30T12:00:00Z",
  body: "Fixes downloads.\n\n- Faster chat\n<!-- internal note -->",
  assets: [
    {
      name: "VupsRouter-windows-x64-setup.exe",
      browser_download_url:
        "https://github.com/CrazyVillainFF/Vups-Router/releases/download/v1.0.9/VupsRouter-windows-x64-setup.exe",
      size: 51_200_000
    },
    {
      name: "VupsRouter-android-release.apk",
      browser_download_url:
        "https://github.com/CrazyVillainFF/Vups-Router/releases/download/v1.0.9/VupsRouter-android-release.apk",
      size: 8_400_000
    },
    {
      name: "VupsRouter-android-test-debug.apk",
      browser_download_url:
        "https://github.com/CrazyVillainFF/Vups-Router/releases/download/v1.0.9/VupsRouter-android-test-debug.apk",
      size: 8_500_000
    }
  ]
};

afterEach(() => {
  delete globalThis.window;
});

test("semantic versions compare numerically, not as strings", () => {
  assert.deepEqual(parseVersion("v1.0.10").parts, [1, 0, 10]);
  assert.equal(compareVersions("1.0.10", "1.0.9"), 1);
  assert.equal(compareVersions("v1.0.9", "1.0.9"), 0);
  assert.equal(compareVersions("1.0.8", "1.0.9"), -1);
  assert.equal(compareVersions("1.0.9-beta.1", "1.0.9"), -1);
  assert.equal(compareVersions("1.0.9", "1.0.9-beta.1"), 1);
  assert.equal(compareVersions("2.0", "1.99.99"), 1);
  assert.equal(displayVersion("v1.0.9"), "1.0.9");
});

test("release metadata is normalised for display", () => {
  assert.equal(releaseVersion(release), "v1.0.9");
  assert.equal(releaseDate(release), "2026-10-30T12:00:00.000Z");
  assert.equal(releaseDate({}), "");
  const notes = releaseNotes(release);
  assert.match(notes, /Fixes downloads/);
  assert.match(notes, /Faster chat/);
  assert.doesNotMatch(notes, /internal note/);
  assert.ok(releaseNotes({ body: "x".repeat(500) }).length <= 320);
  assert.equal(
    releaseNotes({ body: "Intro\n| file | size |\n| --- | --- |\n## Fixes\n- One" }),
    "Intro · Fixes · • One",
    "markdown tables are not flattened into the short note"
  );
});

test("only this repository's own https release assets are accepted", () => {
  assert.equal(isOfficialAssetUrl(release.assets[0].browser_download_url), true);
  assert.equal(isOfficialAssetUrl("http://github.com/CrazyVillainFF/Vups-Router/releases/download/v1/a.exe"), false);
  assert.equal(
    isOfficialAssetUrl("https://github.com.evil/CrazyVillainFF/Vups-Router/releases/download/v1/a.exe"),
    false
  );
  assert.equal(
    isOfficialAssetUrl("https://github.com/SomeoneElse/Vups-Router/releases/download/v1/a.exe"),
    false
  );
  assert.equal(isOfficialAssetUrl("javascript:alert(1)"), false);
  assert.equal(isOfficialAssetUrl(null), false);
});

test("each platform selects only its expected package and falls back honestly", () => {
  const android = selectUpdateAsset(release, "android");
  assert.equal(android.name, "VupsRouter-android-release.apk");
  assert.equal(android.debug, false);
  assert.equal(android.size, 8_400_000);

  const debugOnly = {
    assets: [
      {
        name: "VupsRouter-android-test-debug.apk",
        browser_download_url:
          "https://github.com/CrazyVillainFF/Vups-Router/releases/download/v1.0.9/VupsRouter-android-test-debug.apk",
        size: 8_500_000
      }
    ]
  };
  assert.equal(selectUpdateAsset(debugOnly, "android").debug, true);

  const windows = selectUpdateAsset(release, "windows");
  assert.equal(windows.name, "VupsRouter-windows-x64-setup.exe");

  const poisoned = {
    assets: [
      {
        name: "VupsRouter-android-release.apk",
        browser_download_url: "https://evil.example/VupsRouter-android-release.apk",
        size: 1
      }
    ]
  };
  assert.equal(selectUpdateAsset(poisoned, "android"), null, "a rename is not a trusted URL");
  assert.equal(selectUpdateAsset({ assets: [] }, "windows"), null);
  assert.equal(selectUpdateAsset(release, "linux"), null);
});

test("availability separates current, available, missing-package, and unknown-version states", () => {
  assert.equal(
    updateAvailability({ currentVersion: "1.0.9", latestVersion: "v1.0.9", platform: "android", release }).status,
    "current"
  );
  assert.equal(
    updateAvailability({ currentVersion: "1.0.10", latestVersion: "v1.0.9", platform: "android", release }).status,
    "current",
    "a build newer than the feed is never offered a downgrade"
  );

  const available = updateAvailability({
    currentVersion: "1.0.8",
    latestVersion: "v1.0.9",
    platform: "android",
    release
  });
  assert.equal(available.status, "available");
  assert.equal(available.asset.name, "VupsRouter-android-release.apk");

  const noAsset = updateAvailability({
    currentVersion: "1.0.8",
    latestVersion: "v1.0.9",
    platform: "windows",
    release: { assets: [] }
  });
  assert.equal(noAsset.status, "available");
  assert.equal(noAsset.asset, null);
  assert.match(noAsset.message, /no update package/);

  const unknown = updateAvailability({ currentVersion: "", latestVersion: "v1.0.9", platform: "android", release });
  assert.equal(unknown.status, "info");
  assert.equal(unknown.latestVersion, "v1.0.9");

  assert.equal(
    updateAvailability({ currentVersion: "1.0.8", latestVersion: "", platform: "android", release }).status,
    "error"
  );
});

test("the release check reads only the official GitHub endpoint and reports nothing published yet", async () => {
  const seen = [];
  const found = await checkLatestRelease({
    fetchImpl: async (url, options) => {
      seen.push({ url, options });
      return { status: 200, ok: true, json: async () => release };
    }
  });
  assert.equal(found.release.tag_name, "v1.0.9");
  assert.equal(seen[0].url, "https://api.github.com/repos/CrazyVillainFF/Vups-Router/releases/latest");
  assert.equal(seen[0].options.headers.Accept, "application/vnd.github+json");

  const missing = await checkLatestRelease({ fetchImpl: async () => ({ status: 404, ok: false }) });
  assert.equal(missing.release, null);

  await assert.rejects(
    () => checkLatestRelease({ fetchImpl: async () => ({ status: 500, ok: false }) }),
    /GitHub responded 500/
  );
});

test("check failures map to actionable messages", () => {
  assert.match(updateErrorMessage(new Error("GitHub responded 403")), /rate-limiting/);
  assert.match(updateErrorMessage(new Error("GitHub responded 502")), /update service is unavailable/);
  assert.match(updateErrorMessage(new Error("Failed to fetch")), /Check your connection/);
  assert.match(updateErrorMessage(new Error("weird")), /Unable to check for updates right now/);
});

test("older Android shells are still identified as Android, without an invented version", async () => {
  assert.equal(isAndroidApp(), false);
  globalThis.window = {
    Capacitor: { isNativePlatform: () => true, getPlatform: () => "android", Plugins: {} }
  };
  assert.equal(isAndroidApp(), true);
  assert.equal(appInfoPlugin(), null);
  const info = await installedAppInfo();
  assert.equal(info.platform, "android");
  assert.equal(info.version, "");

  const plugin = { info: async () => ({ version: "1.0.9", build: 10, packageId: "com.vupsrouter.app" }) };
  globalThis.window.Capacitor.Plugins.VupsAppInfo = plugin;
  assert.equal(appInfoPlugin(), plugin);
  assert.deepEqual(await installedAppInfo(), {
    platform: "android",
    version: "1.0.9",
    build: "10",
    packageId: "com.vupsrouter.app"
  });
  assert.equal(isTauriApp(), false);
});

test("the settings page hosts one shared updates section and guards every operation", () => {
  const settings = read("src/desktop/DesktopPages.jsx");
  assert.match(settings, /import ApplicationUpdates from "\.\.\/components\/ApplicationUpdates\.jsx"/);
  assert.match(settings, /<FolderAccessSection \/>\s*<ApplicationUpdates \/>/);

  const component = read("src/components/ApplicationUpdates.jsx");
  assert.match(component, /Installed version/);
  assert.match(component, /Latest version/);
  assert.match(component, /Check for updates/);
  assert.match(component, /isOfficialAssetUrl\(asset\.url\)/);
  assert.match(component, /enqueueAndroidDownload\(/);
  assert.match(component, /installAndroidUpdate\(download\.id\)/);
  assert.match(component, /openExternalUrl\(RELEASES_PAGE_URL\)/);
  assert.match(component, /checkingRef\.current/);
  assert.match(component, /downloadStartingRef\.current/);
  assert.match(component, /installingRef\.current/);
  assert.match(component, /Update download failed/);
  assert.match(component, /Update installation failed/);
  assert.match(component, /isWindowsUpdaterAvailable\(\)/);
  assert.match(component, /checkWindowsUpdate\(\)/);
  assert.match(component, /windowsUpdate\.downloadAndInstall\(/);
  assert.match(component, /restartWindowsApp\(\)/);
  assert.doesNotMatch(component, /signed update manifest|Automatic installation is not configured/);
  assert.doesNotMatch(component, /uninstall/i);
});

test("the Android plugin verifies identity before opening the system installer", () => {
  const plugin = read(`${androidRoot}/java/com/vupsrouter/app/updates/VupsAppInfoPlugin.java`);
  assert.match(plugin, /@CapacitorPlugin\(name = "VupsAppInfo"\)/);
  assert.match(plugin, /getPackageName\(\)\.equals\(archive\.packageName\)/);
  assert.match(plugin, /fingerprints\(installed\)/);
  assert.match(plugin, /fingerprints\(archive\)/);
  assert.match(plugin, /targetCode <= installedCode/);
  assert.match(plugin, /canRequestPackageInstalls/);
  assert.match(plugin, /FileProvider\.getUriForFile/);
  assert.match(plugin, /application\/vnd\.android\.package-archive/);
  assert.match(plugin, /FLAG_GRANT_READ_URI_PERMISSION/);
  assert.doesNotMatch(plugin, /ACTION_DELETE|ACTION_UNINSTALL|uninstall\(/);

  const activity = read(`${androidRoot}/java/com/vupsrouter/app/MainActivity.java`);
  assert.match(activity, /registerPlugin\(VupsAppInfoPlugin\.class\)/);

  const manifest = read(`${androidRoot}/AndroidManifest.xml`);
  assert.match(manifest, /android\.permission\.REQUEST_INSTALL_PACKAGES/);

  const paths = read(`${androidRoot}/res/xml/file_paths.xml`);
  assert.match(paths, /<cache-path name="updates" path="updates\/" \/>/);

  const external = read("src/native/externalLinks.js");
  assert.match(external, /parseExternalUrl/);
  assert.doesNotMatch(componentSource(), /http:\/\//);
});

function componentSource() {
  return read("src/components/ApplicationUpdates.jsx");
}

test("the release page constant comes from the official repository, not a guessed URL", () => {
  assert.equal(RELEASES_PAGE_URL, "https://github.com/CrazyVillainFF/Vups-Router/releases");
});

test("the Windows updater is wired through config, plugins, capability, and package", () => {
  const conf = JSON.parse(read("src-tauri/tauri.conf.json"));
  assert.equal(
    conf.bundle.createUpdaterArtifacts,
    false,
    "the bundler must not sign: the updater signature is made after Authenticode rewrites the installer"
  );
  assert.equal(typeof conf.plugins?.updater?.pubkey, "string", "the updater needs a public key to verify");
  assert.match(
    conf.plugins.updater.pubkey,
    /^dW50cnVzdGVkIGNvbW1lbnQ6IG1pbmlzaWduIHB1YmxpYyBrZXk6/,
    "the embedded key must be a minisign PUBLIC key, never a private key"
  );
  assert.ok(
    conf.plugins.updater.endpoints.includes(
      "https://github.com/CrazyVillainFF/Vups-Router/releases/latest/download/latest.json"
    ),
    "the updater reads the signed manifest published beside the installers"
  );

  const cargo = read("src-tauri/Cargo.toml");
  assert.match(cargo, /tauri-plugin-updater\s*=\s*"2"/);
  assert.match(cargo, /tauri-plugin-process\s*=\s*"2"/);

  const main = read("src-tauri/src/main.rs");
  assert.match(main, /tauri_plugin_updater::Builder::new\(\)\.build\(\)/);
  assert.match(main, /tauri_plugin_process::init\(\)/);

  const capability = JSON.parse(read("src-tauri/capabilities/default.json"));
  assert.ok(capability.permissions.includes("updater:default"));
  assert.ok(capability.permissions.includes("process:allow-restart"));

  const pkg = JSON.parse(read("package.json"));
  assert.match(pkg.dependencies["@tauri-apps/plugin-updater"], /^\^2/);
  assert.match(pkg.dependencies["@tauri-apps/plugin-process"], /^\^2/);
});

test("the release workflow signs the updater after Authenticode and never lets the bundler sign early", () => {
  const wf = read(".github/workflows/native-builds.yml");
  // The bundler must not be switched on anywhere in CI, or the .sig would cover
  // pre-Authenticode bytes and the app would reject its own update.
  assert.doesNotMatch(wf, /createUpdaterArtifacts["']?\s*:\s*true/, "CI must not enable bundler signing");

  const azure = wf.indexOf("azure/artifact-signing-action");
  const pfx = wf.indexOf("SIGNTOOL sign /v /fd SHA256");
  const updaterSign = wf.indexOf("tauri signer sign --app-version");
  const manifest = wf.indexOf("make-updater-manifest.mjs");
  const checksumAll = wf.indexOf("Get-ChildItem release-assets -File");

  assert.ok(updaterSign > 0, "the updater package must be signed by hand");
  assert.ok(manifest > 0, "latest.json must be generated from the signature");
  assert.ok(azure > 0 && updaterSign > azure, "updater signing runs after Azure Authenticode");
  assert.ok(pfx > 0 && updaterSign > pfx, "updater signing runs after PFX Authenticode");
  // The publish gate rejects any attached asset without a build-time checksum,
  // so the checksum step must cover every staged file, not just the installers.
  assert.ok(checksumAll > 0, "checksums must enumerate all release-assets, including .sig and latest.json");
});

test("updater download events fold into honest progress", () => {
  const handle = createUpdaterProgress();
  assert.deepEqual(handle({ event: "Started", data: { contentLength: 100 } }), {
    received: 0,
    total: 100,
    percent: 0
  });
  assert.equal(handle({ event: "Progress", data: { chunkLength: 50 } }).percent, 50);
  assert.equal(handle({ event: "Progress", data: { chunkLength: 50 } }).percent, 100);

  const unknown = createUpdaterProgress();
  assert.equal(unknown({ event: "Started", data: {} }).percent, null);
  assert.equal(unknown({ event: "Progress", data: { chunkLength: 10 } }).percent, null);
  assert.deepEqual(unknown({ event: "Finished" }), { received: 10, total: 10, percent: 100 });
});

test("updater failures map to actionable, non-fabricated messages", () => {
  assert.match(updaterErrorMessage(new Error("Invalid signature")), /could not be verified/);
  assert.match(updaterErrorMessage(new Error("request timed out")), /took too long/);
  assert.match(
    updaterErrorMessage(new Error("error sending request for url (https://github.com/…/latest.json)")),
    /Unable to reach the update service/
  );
  assert.match(updaterErrorMessage(new Error("404 Not Found")), /unavailable right now/);
  assert.match(updaterErrorMessage(new Error("weird")), /weird/);
});

