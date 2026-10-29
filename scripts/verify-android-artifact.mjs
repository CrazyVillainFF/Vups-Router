// Pre-publish gate for an Android APK. Answers the only question a user can
// actually observe: will this file install on their device?
//
// It runs the official SDK tools rather than reimplementing their checks, and
// exits non-zero on the first failure so nothing unverified can be uploaded.
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const args = process.argv.slice(2);
const flag = name => {
  const index = args.indexOf(`--${name}`);
  return index === -1 ? undefined : args[index + 1];
};
const has = name => args.includes(`--${name}`);

const apkPath = flag("apk");
const outDir = flag("out-dir");
const checksDir = flag("checks-dir");
const assetName = flag("asset-name");
const expectedAppId = flag("expected-app-id");
const minBytes = Number(flag("min-bytes") || 0);
const buildTools = flag("build-tools");
const expectDebugKey = has("expect-debug-key");

const failures = [];
const check = (ok, label, detail = "") => {
  if (ok) {
    console.log(`  ok    ${label}${detail ? ` — ${detail}` : ""}`);
  } else {
    console.error(`  FAIL  ${label}${detail ? ` — ${detail}` : ""}`);
    failures.push(label);
  }
};

const tool = name => {
  if (!buildTools) {
    throw new Error(`--build-tools is required so ${name} can be located.`);
  }
  // build-tools ships apksigner as a .bat on Windows and as an extension-less
  // script on Linux, so the gate can be run locally as well as in CI.
  const suffixes = process.platform === "win32" ? [".exe", ".bat", ""] : [""];
  for (const suffix of suffixes) {
    const exe = path.join(buildTools, `${name}${suffix}`);
    if (fs.existsSync(exe)) {
      return exe.endsWith(".bat") ? { cmd: process.env.ComSpec || "cmd.exe", prefix: ["/c", exe] } : { cmd: exe, prefix: [] };
    }
  }
  throw new Error(`${name} was not found in ${buildTools}; the APK cannot be verified.`);
};

const run = (toolRef, argv) => {
  const resolved = typeof toolRef === "string" ? { cmd: toolRef, prefix: [] } : toolRef;
  try {
    return {
      status: 0,
      stdout: execFileSync(resolved.cmd, [...resolved.prefix, ...argv], {
        encoding: "utf8",
        maxBuffer: 64 * 1024 * 1024
      })
    };
  } catch (error) {
    return {
      status: error.status ?? 1,
      stdout: `${error.stdout || ""}${error.stderr || ""}`
    };
  }
};

if (!apkPath || !outDir || !checksDir || !assetName || !expectedAppId) {
  console.error(
    "usage: verify-android-artifact.mjs --apk <file> --out-dir <dir> --checks-dir <dir> " +
      "--asset-name <name> --expected-app-id <id> [--min-bytes n] [--expect-debug-key] --build-tools <dir>"
  );
  process.exit(2);
}

console.log(`[apk] verifying ${apkPath} as ${assetName}`);

// 1. The file is present and big enough to be a real build.
if (!fs.existsSync(apkPath)) {
  console.error(`[apk] ${apkPath} does not exist; the Gradle build produced no APK.`);
  process.exit(1);
}
const stats = fs.statSync(apkPath);
check(stats.size >= minBytes, "file is large enough", `${stats.size} bytes`);

// 2. It is a zip archive, not an HTML error page or an .aar renamed to .apk.
const head = Buffer.alloc(4);
{
  const handle = fs.openSync(apkPath, "r");
  try {
    fs.readSync(handle, head, 0, 4, 0);
  } finally {
    fs.closeSync(handle);
  }
}
check(head[0] === 0x50 && head[1] === 0x4b, "starts with the zip magic PK\\x03\\x04", head.toString("latin1").replace(/[^\x20-\x7e]/g, "."));

// 3. Every entry's CRC still matches, which is what "the package appears to be
//    invalid" usually means when the download is truncated or corrupted.
const aapt = tool("aapt");
const unzipTest = run("unzip", ["-t", apkPath]);
check(unzipTest.status === 0, "every zip entry passes its CRC check", unzipTest.status === 0 ? "" : unzipTest.stdout.trim().split("\n").pop());

// 4. The manifest resolves, and the identity is the one users already have.
const badging = run(aapt, ["dump", "badging", apkPath]);
check(badging.status === 0, "aapt can parse AndroidManifest.xml");
const pkg = /^package: name='([^']+)' versionCode='(\d+)' versionName='([^']*)'/m.exec(badging.stdout);
check(Boolean(pkg), "badging reports the package line", pkg ? pkg[1] : "");
const appId = pkg?.[1] ?? "";
const versionCode = pkg?.[2] ?? "";
const versionName = pkg?.[3] ?? "";
check(appId === expectedAppId, "package id matches the published identity", `${appId || "?"} vs ${expectedAppId}`);
check(/^\d+$/.test(versionCode) && Number(versionCode) > 0, "versionCode is a positive integer", versionCode);
check(
  /^launchable-activity: name='[^']+'/m.test(badging.stdout),
  "the APK declares a launchable activity",
  /launchable-activity: name='([^']+)'/m.exec(badging.stdout)?.[1] ?? ""
);
const minSdk = Number(/^sdkVersion:'(\d+)'/m.exec(badging.stdout)?.[1] ?? 0);
const targetSdk = Number(/^targetSdkVersion:'(\d+)'/m.exec(badging.stdout)?.[1] ?? 0);
check(minSdk > 0 && targetSdk >= 33, "min/target SDK look current", `min ${minSdk || "?"}, target ${targetSdk || "?"}`);

// 5. The web payload is actually inside, so the shell cannot open a blank page
//    and blame the network.
const listing = run("unzip", ["-Z1", apkPath]);
const entries = new Set(listing.stdout.split("\n").filter(Boolean));
check(entries.has("AndroidManifest.xml"), "AndroidManifest.xml is at the archive root");
check(
  [...entries].some(name => /^classes\d*\.dex$/.test(name)),
  "the archive contains dex code"
);
check(entries.has("assets/public/index.html"), "the bundled web client is present");

// 6. The signature. An unsigned APK installs as "invalid" on every device, and
//    a debug key on a release build breaks future updates silently.
const apksigner = tool("apksigner");
const signature = run(apksigner, ["verify", "--verbose", "--print-certs", apkPath]);
check(signature.status === 0, "apksigner verifies the signature");
const signer = /Signer #1 certificate DN: (.+)$/m.exec(signature.stdout)?.[1] ?? "";
const certSha256 = /Signer #1 certificate SHA-256 digest: ([0-9a-f]+)$/im.exec(signature.stdout)?.[1] ?? "";
check(Boolean(signer), "the signer certificate subject is readable", signer);
check(/Verified using v1 scheme \(JAR signing\): true/.test(signature.stdout), "v1 (JAR) signature present");
check(/Verified using v2 scheme \(APK Signature Scheme v2\): true/.test(signature.stdout), "v2 signature present");
const isDebugKey = /androiddebugkey|CN=Android Debug/i.test(signer);
check(
  expectDebugKey ? isDebugKey : !isDebugKey,
  expectDebugKey ? "the test build is signed with the debug key" : "the build is not signed with an Android debug key",
  signer || "no certificate"
);

// 7. Alignment. Unaligned resources make some installers reject the package.
const zipalign = tool("zipalign");
const alignment = run(zipalign, ["-c", "-v", "4", apkPath]);
check(
  alignment.status === 0 && /Verification successful/i.test(alignment.stdout),
  "zipalign reports the archive is aligned",
  alignment.stdout.trim().split("\n").pop()
);

if (failures.length > 0) {
  console.error(`[apk] ${failures.length} check(s) failed: ${failures.join(", ")}`);
  console.error("[apk] refusing to publish an unverified APK.");
  process.exit(1);
}

fs.mkdirSync(outDir, { recursive: true });
fs.mkdirSync(checksDir, { recursive: true });
const staged = path.join(outDir, assetName);
fs.copyFileSync(apkPath, staged);
const hash = createHash("sha256").update(fs.readFileSync(staged)).digest("hex");
const platform = assetName === process.env.ANDROID_RELEASE_ASSET ? "android-release" : "android-debug";
// Every key is namespaced per platform: the publish job sources both files, and
// a shared name would let the debug build overwrite the release build's result.
const prefix = platform === "android-debug" ? "ANDROID_DEBUG" : "ANDROID_RELEASE";
fs.writeFileSync(path.join(checksDir, `${platform}.sha256`), `${hash}  ${assetName}\n`);
fs.writeFileSync(
  path.join(checksDir, `${platform}.env`),
  [
    `${prefix}_APP_ID="${appId}"`,
    `${prefix}_VERSION_CODE="${versionCode}"`,
    `${prefix}_VERSION_NAME="${versionName}"`,
    `${prefix}_SIGNER="${signer.replace(/"/g, "'")}"`,
    `${prefix}_CERT_SHA256="${certSha256}"`,
    `${prefix}_IS_RELEASE_KEY="${expectDebugKey ? "false" : "true"}"`
  ].join("\n") + "\n"
);
console.log(`[apk] staged ${staged} (${stats.size} bytes)`);
console.log(`[apk] sha256 ${hash}`);
console.log(`[apk] certificate sha256 ${certSha256}`);
console.log(`[apk] all checks passed for ${appId} ${versionName} (${versionCode})`);
