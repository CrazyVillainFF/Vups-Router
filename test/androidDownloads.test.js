import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, test } from "node:test";

import {
  androidDownloadsPlugin,
  androidNotificationsStatus,
  blobToBase64,
  cancelAndroidDownload,
  clearFinishedAndroidDownloads,
  enqueueAndroidDownload,
  isAndroidDownloadsAvailable,
  listAndroidDownloads,
  openAndroidDownload,
  requestAndroidNotifications,
  retryAndroidDownload,
  saveBlobToAndroid,
  subscribeAndroidDownloadEvents
} from "../src/native/androidDownloads.js";
import {
  activeDownloadCount,
  applyDownloadEvent,
  downloadPercent,
  downloadProgressLabel,
  downloadSizeText,
  downloadSpeedText,
  downloadStatusText,
  finishedDownloadCount,
  isActiveDownload,
  normalizeDownload
} from "../src/download/nativeDownloadState.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = file => readFileSync(path.join(root, file), "utf8");
const androidRoot = "android/app/src/main";

function installCapacitor(plugin, platform = "android") {
  globalThis.window = {
    Capacitor: {
      isNativePlatform: () => true,
      getPlatform: () => platform,
      Plugins: plugin ? { VupsDownloads: plugin } : {}
    }
  };
}

afterEach(() => {
  delete globalThis.window;
});

test("the native bridge only activates inside the Android shell", () => {
  assert.equal(androidDownloadsPlugin(), null, "no window means no bridge");
  assert.equal(isAndroidDownloadsAvailable(), false);

  installCapacitor({}, "ios");
  assert.equal(androidDownloadsPlugin(), null, "iOS is not the Android downloads shell");

  installCapacitor(null);
  assert.equal(androidDownloadsPlugin(), null, "a shell without the plugin stays on the web path");

  const plugin = { list: async () => ({ downloads: [] }) };
  installCapacitor(plugin);
  assert.equal(androidDownloadsPlugin(), plugin);
  assert.equal(isAndroidDownloadsAvailable(), true);
});

test("blob bytes survive the base64 bridge unchanged", async () => {
  const blob = new Blob([Uint8Array.from([0, 1, 2, 127, 128, 250, 255])], { type: "application/octet-stream" });
  const encoded = await blobToBase64(blob);
  assert.equal(atob(encoded), "\u0000\u0001\u0002\u007f\u0080\u00fa\u00ff");
  await assert.rejects(() => blobToBase64(null), /cannot be downloaded on Android/);
});

test("saveBlobToAndroid stays synchronous on the web and hands bytes to the service natively", async () => {
  assert.equal(saveBlobToAndroid(new Blob(["hello"]), "hello.txt"), null);

  const calls = [];
  installCapacitor({
    saveBlob: async payload => {
      calls.push(payload);
      return { id: "dl-1" };
    }
  });
  const pending = saveBlobToAndroid(new Blob(["hello world"], { type: "text/plain" }), "hello.txt");
  assert.equal(typeof pending?.then, "function");
  assert.equal(await pending, "dl-1");
  assert.equal(calls.length, 1);
  assert.equal(atob(calls[0].base64), "hello world");
  assert.equal(calls[0].filename, "hello.txt");
  assert.equal(calls[0].mimeType, "text/plain");

  const unnamed = saveBlobToAndroid(new Blob(["x"]), "");
  await unnamed;
  assert.equal(calls[1].filename, "download");
  assert.equal(calls[1].mimeType, "application/octet-stream");
});

test("download commands degrade safely on the web and forward ids natively", async () => {
  assert.deepEqual(await listAndroidDownloads(), []);
  assert.deepEqual(await androidNotificationsStatus(), { granted: true, canRequest: false, enabled: true });
  assert.deepEqual(await requestAndroidNotifications(), { granted: true, canRequest: false, enabled: true });
  await cancelAndroidDownload("x");
  await retryAndroidDownload("x");
  await openAndroidDownload("x");
  await clearFinishedAndroidDownloads();
  await assert.rejects(() => enqueueAndroidDownload({ url: "https://example.com/a.zip" }), /not available in this app/);

  const calls = [];
  installCapacitor({
    enqueue: async options => {
      calls.push(["enqueue", options]);
      return { id: "dl-2" };
    },
    cancel: async options => calls.push(["cancel", options]),
    retry: async options => calls.push(["retry", options]),
    openFile: async options => calls.push(["openFile", options]),
    clearFinished: async () => calls.push(["clearFinished"]),
    requestNotifications: async () => ({ granted: true, canRequest: true, enabled: true })
  });
  assert.deepEqual(await enqueueAndroidDownload({ url: "https://example.com/a.zip", filename: "a.zip" }), { id: "dl-2" });
  await cancelAndroidDownload("dl-2");
  await retryAndroidDownload("dl-2");
  await openAndroidDownload("dl-2");
  await clearFinishedAndroidDownloads();
  assert.deepEqual(calls, [
    ["enqueue", { url: "https://example.com/a.zip", filename: "a.zip", mimeType: undefined }],
    ["cancel", { id: "dl-2" }],
    ["retry", { id: "dl-2" }],
    ["openFile", { id: "dl-2" }],
    ["clearFinished"]
  ]);
});

test("event subscriptions remove async and sync listener handles exactly once", async () => {
  let received = null;
  let resolveHandle;
  const pendingHandle = new Promise(resolve => {
    resolveHandle = resolve;
  });
  let removed = 0;
  installCapacitor({
    addListener: (event, callback) => {
      assert.equal(event, "download");
      received = callback;
      return pendingHandle;
    }
  });
  const unsubscribe = subscribeAndroidDownloadEvents(event => {
    received = event;
  });
  assert.equal(typeof received, "function");
  unsubscribe();
  resolveHandle({ remove: () => { removed += 1; } });
  await pendingHandle;
  await Promise.resolve();
  assert.equal(removed, 1);

  let syncRemoved = 0;
  installCapacitor({ addListener: () => ({ remove: () => { syncRemoved += 1; } }) });
  const stop = subscribeAndroidDownloadEvents(() => {});
  stop();
  assert.equal(syncRemoved, 1);
});

test("download state helpers normalize, order, and describe live downloads", () => {
  assert.deepEqual(normalizeDownload({ id: "a", status: "teleported" }), {
    id: "a",
    filename: "download",
    mimeType: "",
    status: "failed",
    bytes: 0,
    total: -1,
    speedBytesPerSecond: 0,
    error: "",
    createdAt: 0,
    updatedAt: 0,
    canOpen: false,
    canRetry: false
  });
  assert.equal(isActiveDownload({ status: "queued" }), true);
  assert.equal(isActiveDownload({ status: "running" }), true);
  assert.equal(isActiveDownload({ status: "completed" }), false);

  const running = normalizeDownload({
    id: "a",
    status: "running",
    filename: "report.zip",
    bytes: 1536,
    total: 4096,
    speedBytesPerSecond: 2048,
    createdAt: 10
  });
  assert.equal(downloadPercent(running), 37);
  assert.equal(downloadSizeText(running), "1.5 KB of 4.0 KB");
  assert.equal(downloadSpeedText(2048), "2.0 KB/s");
  assert.equal(downloadStatusText(running), "37% · 1.5 KB of 4.0 KB · 2.0 KB/s");
  assert.equal(downloadProgressLabel(running), "37% downloaded");

  const unknown = normalizeDownload({ id: "b", status: "running", bytes: 300 });
  assert.equal(downloadPercent(unknown), null);
  assert.equal(downloadStatusText(unknown), "300 B downloaded");
  assert.equal(downloadProgressLabel(unknown), "Downloading, size unknown");

  const queued = normalizeDownload({ id: "c", status: "queued" });
  assert.equal(downloadStatusText(queued), "Waiting to start…");
  const completed = normalizeDownload({ id: "d", status: "completed", total: 2048 });
  assert.equal(downloadStatusText(completed), "Complete · 2.0 KB");
  assert.equal(downloadStatusText(normalizeDownload({ id: "e", status: "cancelled" })), "Cancelled");
  assert.equal(downloadStatusText(normalizeDownload({ id: "f", status: "failed", error: "Network lost" })), "Network lost");

  const list = [normalizeDownload({ id: "old", createdAt: 1 })];
  const updated = applyDownloadEvent(list, { id: "new", status: "running", createdAt: 2 });
  assert.deepEqual(updated.map(item => item.id), ["new", "old"]);
  const progressed = applyDownloadEvent(updated, { id: "new", status: "running", bytes: 5, createdAt: 2 });
  assert.equal(progressed.length, 2);
  assert.equal(progressed.find(item => item.id === "new").bytes, 5);
  assert.deepEqual(applyDownloadEvent(progressed, { id: "new", status: "removed" }).map(item => item.id), ["old"]);
  assert.equal(activeDownloadCount(updated), 1);
  assert.equal(finishedDownloadCount(updated), 1);
});

test("existing download handlers wait for the native service instead of assuming success", () => {
  const downloads = read("src/chat/downloads.js");
  assert.match(downloads, /const native = saveBlobToAndroid/);
  assert.ok(
    downloads.indexOf("saveBlobToAndroid(blob, filename)") < downloads.indexOf("URL.createObjectURL"),
    "the native path must run before the blob URL path"
  );

  const files = read("src/components/GeneratedFiles.jsx");
  assert.match(files, /const pending = downloadGeneratedFile/);
  assert.match(files, /pending\?\.then\) pending\.catch\(fail\)/);
  assert.match(files, /await downloadBlob\(blob, projectZipName\(\)/);

  const chatPage = read("src/ChatPage.jsx");
  assert.match(chatPage, /const pending = downloadBlob/);
  assert.match(chatPage, /pending\.then\(\(\) => markRecovery\("downloaded"\), fail\)/);
});

test("the in-app download manager is mounted for every screen", () => {
  const app = read("src/App.jsx");
  assert.match(app, /import AndroidDownloadManager from "\.\/components\/AndroidDownloadManager\.jsx"/);
  assert.match(app, /<AuthProvider><LinkErrorToast \/><AndroidDownloadManager \/>/);
});

test("Android registers the downloads plugin, foreground service, and notification permission", () => {
  const manifest = read(`${androidRoot}/AndroidManifest.xml`);
  assert.match(manifest, /<uses-permission android:name="android\.permission\.POST_NOTIFICATIONS" \/>/);
  assert.match(manifest, /<uses-permission android:name="android\.permission\.FOREGROUND_SERVICE" \/>/);
  assert.match(manifest, /<uses-permission android:name="android\.permission\.FOREGROUND_SERVICE_DATA_SYNC" \/>/);
  assert.match(
    manifest,
    /<service\s+android:name="\.downloads\.DownloadService"\s+android:exported="false"\s+android:foregroundServiceType="dataSync" \/>/
  );

  const activity = read(`${androidRoot}/java/com/vupsrouter/app/MainActivity.java`);
  assert.match(activity, /registerPlugin\(VupsDownloadsPlugin\.class\)/);
  assert.match(activity, /setDownloadListener/);
  assert.match(activity, /url\.startsWith\("https:\/\/"\)/);
  assert.match(activity, /CookieManager\.getInstance\(\)\.getCookie\(url\)/);

  const plugin = read(`${androidRoot}/java/com/vupsrouter/app/downloads/VupsDownloadsPlugin.java`);
  assert.match(plugin, /@CapacitorPlugin\([\s\S]*?name = "VupsDownloads"/);
  assert.match(plugin, /Manifest\.permission\.POST_NOTIFICATIONS/);
  assert.match(plugin, /requestPermissionForAlias\("notifications"/);
  assert.match(plugin, /saveBlob/);
  assert.match(plugin, /enqueue/);
});

test("notifications carry filenames and progress but never the source URL or credentials", () => {
  const service = read(`${androidRoot}/java/com/vupsrouter/app/downloads/DownloadService.java`);
  assert.match(service, /"Downloading file"/);
  assert.match(service, /"Download complete"/);
  assert.match(service, /"Download failed"/);
  assert.match(service, /"Tap to open"/);
  assert.match(service, /"Tap to retry"/);
  assert.match(service, /NotificationCompat\.VISIBILITY_PRIVATE/);
  assert.match(service, /NotificationManager\.IMPORTANCE_LOW/);
  assert.match(service, /startForegroundFor\(record\)/);
  assert.match(service, /STOP_FOREGROUND_DETACH/);

  const notification = service.slice(
    service.indexOf("private Notification buildNotification"),
    service.indexOf("public PendingIntent openPendingIntent")
  );
  assert.ok(notification.length > 0, "notification builder must exist");
  assert.doesNotMatch(notification, /sourceUrl/);
  assert.doesNotMatch(notification, /cookie/i);

  const store = read(`${androidRoot}/java/com/vupsrouter/app/downloads/DownloadStore.java`);
  const snapshot = store.slice(store.indexOf("public static JSONObject snapshot"), store.indexOf("private static void emit"));
  assert.ok(snapshot.includes('"canOpen"'));
  assert.ok(snapshot.includes('"canRetry"'));
  assert.doesNotMatch(snapshot, /sourceUrl|cookie/i);
});

test("the service handles every start action under the foreground-service deadline", () => {
  const service = read(`${androidRoot}/java/com/vupsrouter/app/downloads/DownloadService.java`);
  const onStart = service.slice(service.indexOf("public int onStartCommand"), service.indexOf("private", service.indexOf("public int onStartCommand")));
  assert.match(onStart, /startForegroundFor/);
  assert.match(service, /ContextCompat\.startForegroundService/);
  assert.match(service, /startForeground\(/);
});
