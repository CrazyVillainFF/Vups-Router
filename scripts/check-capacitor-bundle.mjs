// Runs after `cap sync` and before Gradle, so a missing web payload fails at
// the step that caused it instead of producing an APK that opens a blank page.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = file => {
  const full = path.join(root, file);
  if (!fs.existsSync(full) || fs.statSync(full).size === 0) {
    console.error(`[capacitor] ${file} is missing or empty — 'npx cap sync android' did not copy the web assets.`);
    process.exit(1);
  }
  return full;
};

read("android/app/src/main/assets/public/index.html");
const configPath = read("android/app/src/main/assets/capacitor.config.json");
const config = JSON.parse(fs.readFileSync(configPath, "utf8"));

const url = config?.server?.url;
if (url) {
  if (!url.startsWith("https://")) {
    console.error(`[capacitor] server.url must be HTTPS, got ${url}`);
    process.exit(1);
  }
  if (/localhost|127\.0\.0\.1|\[::1\]|10\.0\.2\.2|192\.168\./.test(url)) {
    console.error(
      `[capacitor] server.url points at a development host (${url}). ` +
        "On a phone, localhost is the phone itself, so chat can only ever fail."
    );
    process.exit(1);
  }
  console.log(`[capacitor] shell loads the remote app at ${url}`);
} else {
  const assets = "android/app/src/main/assets/public/assets";
  if (!fs.existsSync(path.join(root, assets)) || fs.readdirSync(path.join(root, assets)).length === 0) {
    console.error(`[capacitor] ${assets} has no bundled files, so the shell would load a blank page.`);
    process.exit(1);
  }
  console.log("[capacitor] shell serves the bundled assets from assets/public");
}

if (config?.android?.allowMixedContent) {
  console.error("[capacitor] allowMixedContent is enabled; a WebView with HTTP content inside an HTTPS shell is not shippable.");
  process.exit(1);
}
if (config?.server?.cleartext === true) {
  console.error("[capacitor] server.cleartext is enabled; refusing to package an app that can fall back to plain HTTP.");
  process.exit(1);
}
if (config?.android?.webContentsDebuggingEnabled) {
  console.error("[capacitor] webContentsDebuggingEnabled is on; any app on the device could inspect the WebView.");
  process.exit(1);
}
console.log("[capacitor] packaged app configuration is safe to ship.");
