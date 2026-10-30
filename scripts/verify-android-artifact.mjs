// Pre-publish gate for an Android APK. Answers the only question a user can
// actually observe: will this file install on their device?
//
// It runs the official SDK tools rather than reimplementing their checks, and
// exits non-zero on the first failure so nothing unverified can be uploaded.
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { looksLikeDebugCertificate, readApksignerCertificate, readKeytoolCertificate } from "./android-signature-reader.mjs";

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
const expectedCertSha256 = flag("expected-cert-sha256");

const failures = [];
const check = (ok, label, detail = "") => {
  if (ok) {
    console.log(`  ok    ${label}${detail ? ` — ${detail}` : ""}`);
  } else {
    console.error(`  FAIL  ${label}${detail ? ` — ${detail}` : ""}`);
    failures.push(label);
  }
};

const lastLine = text => String(text || "").trim().split(/\r?\n/).pop() || "";

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
  const result = spawnSync(resolved.cmd, [...resolved.prefix, ...argv], {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024
  });
  const stdout = result.stdout || "";
  const stderr = result.stderr || "";
  return {
    // A tool that could not be started is not a tool that reported a failure,
    // but both have to stop the gate, so the reason is kept next to the code.
    status: result.error ? 127 : (result.status ?? 1),
    error: result.error ? `${result.error.code || result.error.name}: ${result.error.message}` : "",
    stdout,
    stderr,
    // Parsing has to see both streams: reading only stdout silently turns a
    // tool that reports on stderr into "no output" and, for the signature
    // checks, into an APK that looks unsigned.
    all: stderr ? `${stdout}\n${stderr}` : stdout
  };
};

// keytool ships with the same JDK that apksigner needs to run, so it is
// available wherever the SDK tools are, and it reads the certificate out of the
// APK's own signature block instead of out of a formatter's text.
const keytoolRef = () => {
  const exe = process.platform === "win32" ? "keytool.exe" : "keytool";
  const fromJavaHome = process.env.JAVA_HOME ? path.join(process.env.JAVA_HOME, "bin", exe) : "";
  return { cmd: fromJavaHome && fs.existsSync(fromJavaHome) ? fromJavaHome : exe, prefix: [] };
};

if (!apkPath || !outDir || !checksDir || !assetName || !expectedAppId) {
  console.error(
    "usage: verify-android-artifact.mjs --apk <file> --out-dir <dir> --checks-dir <dir> " +
      "--asset-name <name> --expected-app-id <id> [--min-bytes n] [--expect-debug-key] " +
      "[--expected-cert-sha256 <hex>] --build-tools <dir>"
  );
  process.exit(2);
}
// A release build that is merely "not debug" can still rotate to a new key and
// break every existing install. The published release identity is pinned.
if (!expectDebugKey && !expectedCertSha256) {
  console.error(
    "release builds must pin --expected-cert-sha256; otherwise a rotated signing key would publish an APK that cannot update existing installs."
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
check(unzipTest.status === 0, "every zip entry passes its CRC check", unzipTest.status === 0 ? "" : lastLine(unzipTest.error || unzipTest.all));

// 4. The manifest resolves, and the identity is the one users already have.
const badging = run(aapt, ["dump", "badging", apkPath]);
check(badging.status === 0, "aapt can parse AndroidManifest.xml", badging.status === 0 ? "" : lastLine(badging.error || badging.all));
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
check(signature.status === 0, "apksigner verifies the signature", signature.status === 0 ? "" : lastLine(signature.error || signature.all));
const fromApksigner = readApksignerCertificate(signature.all);
const crossCheck = run(keytoolRef(), ["-printcert", "-jarfile", apkPath]);
const fromKeytool = readKeytoolCertificate(crossCheck.all);
// keytool is a cross-check, not a second gate: an APK signed without a v1 block
// or a JDK that predates `-jarfile` leaves it speechless, and that must not
// block a build the SDK itself verifies.
if (crossCheck.status !== 0 || !fromKeytool.sha256) {
  console.log(`[apk] note: keytool cross-check unavailable (${crossCheck.error || `exit ${crossCheck.status}`})`);
} else if (!fromApksigner.sha256) {
  console.log("[apk] note: apksigner printed no certificate block; the identity below came from keytool.");
}
if (fromApksigner.sha256 && fromKeytool.sha256 && fromApksigner.certificateCount === 1 && fromKeytool.certificateCount === 1) {
  check(
    fromApksigner.sha256 === fromKeytool.sha256,
    "the SDK and the JDK read the same signing certificate",
    `apksigner ${fromApksigner.sha256}, keytool ${fromKeytool.sha256}`
  );
}
const signer = fromApksigner.subject || fromKeytool.subject;
const certSha256 = fromApksigner.sha256 || fromKeytool.sha256;
check(Boolean(signer), "the signer certificate subject is readable", signer);
if (!signer) {
  // A certificate that cannot be read must never be mistaken for an APK that is
  // merely unsigned, so the text both tools actually produced is kept here.
  console.error("  apksigner stdout/stderr, signer-related lines:");
  const lines = signature.all.split(/\r?\n/).filter(line => /signer|verif|certificate/i.test(line));
  for (const line of lines.slice(0, 15)) console.error(`    | ${line}`);
  if (!lines.length) console.error("    | (apksigner produced no output)");
  console.error(`  keytool exit ${crossCheck.status} ${crossCheck.error || ""}, output ${lastLine(crossCheck.all) || "(empty)"}`);
}
check(/Verified using v1 scheme \(JAR signing\): true/.test(signature.all), "v1 (JAR) signature present");
check(/Verified using v2 scheme \(APK Signature Scheme v2\): true/.test(signature.all), "v2 signature present");
const isDebugKey = looksLikeDebugCertificate(signer);
check(
  expectDebugKey ? isDebugKey : !isDebugKey,
  expectDebugKey ? "the test build is signed with the debug key" : "the build is not signed with an Android debug key",
  signer || "no certificate"
);
if (expectedCertSha256) {
  check(
    certSha256.toLowerCase() === expectedCertSha256.toLowerCase(),
    "the signer certificate matches the pinned release identity",
    certSha256 || "no certificate"
  );
}

// 7. Alignment. Unaligned resources make some installers reject the package.
const zipalign = tool("zipalign");
const alignment = run(zipalign, ["-c", "-v", "4", apkPath]);
// zipalign's own success line is misspelled ("succesful") in AOSP, so matching
// only the correct spelling would reject every correctly aligned APK.
check(
  alignment.status === 0 && /Verification succe(ss|s)ful/i.test(alignment.all),
  "zipalign reports the archive is aligned",
  alignment.status === 0 ? lastLine(alignment.all) : lastLine(alignment.error || alignment.all)
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
console.log(`[apk] certificate sha256 ${certSha256} (read by ${fromApksigner.sha256 ? "apksigner" : "keytool"})`);
console.log(`[apk] all checks passed for ${appId} ${versionName} (${versionCode})`);
