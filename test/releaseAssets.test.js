import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import {
  DOWNLOADS,
  LATEST_RELEASE_API_URL,
  RELEASE_ASSETS,
  RELEASE_REPO,
  RELEASE_STATUS,
  androidRelease,
  formatReleaseSize,
  latestAssetDownloadUrl,
  mergeLiveReleases,
  releasePageUrl,
  releasePublishedDate,
  releaseVersion,
  statusFor,
  verifiedAsset,
  windowsRelease
} from "../src/download/releases.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = file => readFileSync(path.join(root, file), "utf8");
const workflow = read(".github/workflows/native-builds.yml");
const readme = read("README.md");

const asset = (name, size = 5883089, url) => ({
  name,
  size,
  browser_download_url: url || `https://github.com/${RELEASE_REPO}/releases/download/v1.0.0/${name}`
});

const release = assets => ({
  tag_name: "v1.0.0",
  html_url: `https://github.com/${RELEASE_REPO}/releases/tag/v1.0.0`,
  published_at: "2026-10-28T10:00:00Z",
  draft: false,
  prerelease: false,
  assets
});

test("1. advertised asset names match the workflow that publishes them", () => {
  for (const name of Object.values(RELEASE_ASSETS)) {
    assert.ok(workflow.includes(name), `native-builds.yml must publish ${name}`);
  }
  // releases/latest only resolves for a published, non-draft, non-prerelease tag.
  assert.match(workflow, /--latest/);
  assert.match(workflow, /--verify-tag/);
  assert.doesNotMatch(workflow, /--draft|--prerelease/);
  assert.equal(LATEST_RELEASE_API_URL, `https://api.github.com/repos/${RELEASE_REPO}/releases/latest`);
});

test("2. the static map advertises no installer before the release is read", () => {
  assert.equal(DOWNLOADS.windows.downloadUrl, null);
  assert.equal(DOWNLOADS.android.downloadUrl, null);
  assert.equal(statusFor(DOWNLOADS.windows).tone, "pending");
});

test("3. with no published release nothing is linked", () => {
  const merged = mergeLiveReleases(DOWNLOADS, null);
  for (const platform of ["windows", "android"]) {
    assert.equal(merged[platform].downloadUrl, null, `${platform} must not link an installer`);
    assert.notEqual(merged[platform].status, "available");
  }
  assert.equal(merged.web.downloadUrl, "https://vups-router-three.vercel.app/");
  assert.equal(mergeLiveReleases(DOWNLOADS, undefined).windows.downloadUrl, null);
});

test("4. a published installer becomes a real download with real metadata", () => {
  const live = release([asset(RELEASE_ASSETS.windowsInstaller)]);
  const merged = mergeLiveReleases(DOWNLOADS, live);
  assert.equal(merged.windows.status, "available");
  assert.equal(merged.windows.downloadUrl, live.assets[0].browser_download_url);
  assert.equal(merged.windows.version, "1.0.0");
  assert.equal(merged.windows.fileSize, "5.6 MB");
  assert.equal(merged.windows.publishedAt, "2026-10-28");
  assert.equal(merged.windows.releaseNotesUrl, live.html_url);
  assert.match(merged.windows.install.join(" "), /SmartScreen/);
});

test("5. a release without the platform asset says so instead of guessing", () => {
  const merged = mergeLiveReleases(DOWNLOADS, release([asset("unrelated.txt", 10)]));
  assert.equal(merged.windows.status, "not-published");
  assert.equal(merged.windows.downloadUrl, null);
  assert.match(merged.windows.target, /1\.0\.0/);
  assert.equal(merged.android.status, "not-published");
});

test("6. a debug-only APK is never presented as a production release", () => {
  const merged = mergeLiveReleases(DOWNLOADS, release([asset(RELEASE_ASSETS.androidDebugApk, 4400000)]));
  assert.equal(merged.android.status, "test-build");
  assert.notEqual(merged.android.status, "available");
  assert.match(RELEASE_STATUS[merged.android.status].label, /debug/i);
  assert.match(merged.android.title, /test build/);
  assert.match(merged.android.description, /not a Play Store release/i);
  assert.match(merged.android.install.join(" "), /debug-signed/);
  assert.match(merged.android.target, /debug key|Test build/i);
});

test("7. a release-signed APK wins over the debug build and reads as available", () => {
  const signed = release([
    asset(RELEASE_ASSETS.androidDebugApk, 4400000),
    asset(RELEASE_ASSETS.androidReleaseApk, 4300000)
  ]);
  const merged = mergeLiveReleases(DOWNLOADS, signed);
  assert.equal(merged.android.status, "available");
  assert.equal(merged.android.downloadUrl, signed.assets[1].browser_download_url);
  assert.match(merged.android.format, /release-signed/);
  assert.match(merged.android.install.join(" "), /allow installs from this source/);
});

test("8. only this repository's release assets are trusted", () => {
  const hostile = [
    asset(RELEASE_ASSETS.windowsInstaller, 100, "https://evil.example/setup.exe"),
    asset(RELEASE_ASSETS.windowsInstaller, 100, "http://github.com/other/repo/releases/download/v1/x.exe"),
    asset(RELEASE_ASSETS.windowsInstaller, 100, "https://github.com/other-repo/repo/releases/download/v1/x.exe")
  ];
  for (const item of hostile) {
    assert.equal(verifiedAsset(release([item]), RELEASE_ASSETS.windowsInstaller), null, item.browser_download_url);
  }
  assert.equal(verifiedAsset(null, RELEASE_ASSETS.windowsInstaller), null);
  assert.equal(verifiedAsset({ assets: "nope" }, RELEASE_ASSETS.windowsInstaller), null);
  assert.equal(verifiedAsset(release([asset(RELEASE_ASSETS.windowsInstaller)]), RELEASE_ASSETS.windowsMsi), null);
  assert.equal(windowsRelease(release(hostile)).downloadUrl, null);
});

test("9. latest-release links are version-free so they stay permanent", () => {
  assert.equal(
    latestAssetDownloadUrl(RELEASE_ASSETS.windowsInstaller),
    `https://github.com/${RELEASE_REPO}/releases/latest/download/VupsRouter-windows-x64-setup.exe`
  );
  assert.doesNotMatch(latestAssetDownloadUrl(RELEASE_ASSETS.androidDebugApk), /v\d+\.\d+/);
});

test("10. size, version, date and page helpers refuse bad input", () => {
  assert.equal(formatReleaseSize(5883089), "5.6 MB");
  assert.equal(formatReleaseSize(1048576), "1.0 MB");
  assert.equal(formatReleaseSize(512), "1 KB");
  assert.equal(formatReleaseSize(0), null);
  assert.equal(formatReleaseSize(-1), null);
  assert.equal(formatReleaseSize("abc"), null);
  assert.equal(releaseVersion({ tag_name: "v2.1.0" }), "2.1.0");
  assert.equal(releaseVersion({}), null);
  assert.equal(releasePublishedDate({ published_at: "not a date" }), null);
  assert.equal(releasePublishedDate({ created_at: "2026-01-02T00:00:00Z" }), "2026-01-02");
  assert.equal(releasePageUrl(release([])), `https://github.com/${RELEASE_REPO}/releases/tag/v1.0.0`);
  assert.equal(releasePageUrl({ html_url: "https://evil.example/" }), null);
});

test("11. the README download block links real files, never localhost", () => {
  const start = readme.indexOf("## Download VupsRouter");
  assert.notEqual(start, -1, "the download section must exist");
  const block = readme.slice(start, readme.indexOf("###", start));

  assert.match(block, /Download for Windows/);
  assert.match(block, /Download for Android/);
  assert.match(block, /Use the Web App/);
  assert.match(block, /All Releases/);
  assert.match(block, /https:\/\/vups-router-three\.vercel\.app\//);
  assert.ok(
    block.includes(`https://github.com/${RELEASE_REPO}/releases`),
    "the download block must link the releases page"
  );

  // Every stable download path in the block is a name CI actually publishes.
  const paths = [...block.matchAll(/releases\/latest\/download\/([A-Za-z0-9._-]+)/g)].map(match => match[1]);
  assert.ok(paths.length >= 2, "Windows and Android both need a direct download path");
  for (const name of paths) {
    assert.ok(Object.values(RELEASE_ASSETS).includes(name), `README advertises ${name}, which CI never publishes`);
    assert.ok(workflow.includes(name));
  }
  assert.ok(paths.includes(RELEASE_ASSETS.windowsInstaller), "Windows installer needs a direct link");

  assert.doesNotMatch(block, /localhost|127\.0\.0\.1/, "downloads must never point at a dev server");
  assert.doesNotMatch(block, /src-tauri|target[\\/]release/, "downloads must never point at a source folder");
  // The debug APK must stay labelled as a test build in the README too.
  const androidLine = block.split("\n").find(line => line.includes(RELEASE_ASSETS.androidDebugApk) || /test build/i.test(line));
  assert.match(`${androidLine || ""}`, /debug|test/i);
});

test("12. the page reads releases live instead of hardcoding them", () => {
  const page = read("src/pages/DownloadPage.jsx");
  const hook = read("src/download/useGitHubRelease.js");
  assert.match(page, /useGitHubRelease\(\)/);
  assert.match(page, /mergeLiveReleases\(DOWNLOADS, live\.release\)/);
  assert.match(hook, /LATEST_RELEASE_API_URL/);
  assert.match(hook, /response\.status === 404/);
  assert.match(hook, /AbortController/);
  assert.match(hook, /controller\.abort\(\)/);
  // No installer URL may be baked into the page component itself.
  assert.doesNotMatch(page, /browser_download_url|releases\/download\//);
});

test("13. every published version string tracks package.json", () => {
  const version = JSON.parse(read("package.json")).version;
  assert.equal(DOWNLOADS.web.version, version, "the web card must show the client's own version");
  assert.equal(JSON.parse(read("src-tauri/tauri.conf.json")).version, version, "the Tauri bundle must match");
  assert.ok(read("android/app/build.gradle").includes(`versionName "${version}"`), "the APK versionName must match");
});
