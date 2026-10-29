import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = file => readFileSync(path.join(root, file), "utf8");
// Checked out with CRLF on Windows, and the job boundaries below are matched on
// newlines.
const workflow = read(".github/workflows/native-builds.yml").replaceAll("\r\n", "\n");
const apkGate = read("scripts/verify-android-artifact.mjs");
const bundleGate = read("scripts/check-capacitor-bundle.mjs");

// Split the jobs section on its two-space-indented keys. The workflow is YAML,
// but every assertion here is about the text of a shell script inside it, so a
// parser would only add a dependency.
const jobBodies = (() => {
  const jobsSection = workflow.slice(workflow.indexOf("\njobs:\n"));
  const marks = [...jobsSection.matchAll(/\n {2}([a-z][a-z0-9-]*):\n/g)];
  const map = new Map();
  marks.forEach((mark, index) => {
    const start = mark.index + mark[0].length;
    const end = marks[index + 1] ? marks[index + 1].index : jobsSection.length;
    map.set(mark[1], jobsSection.slice(start, end));
  });
  return map;
})();

const jobBody = name => {
  const body = jobBodies.get(name);
  assert.ok(body, `native-builds.yml has no ${name} job (found: ${[...jobBodies.keys()].join(", ")})`);
  return body;
};

test("1. every Android build passes the verifier before it can be uploaded", () => {
  for (const job of ["android-debug", "android-release"]) {
    const body = jobBody(job);
    assert.match(body, /scripts\/verify-android-artifact\.mjs/, `${job} must run the APK verifier`);
    assert.match(body, /--expected-app-id "\$ANDROID_APP_ID"/, `${job} must pin the package id`);
    assert.match(body, /--min-bytes "\$MIN_ARTIFACT_BYTES"/, `${job} must reject an implausibly small file`);
    const verify = body.indexOf("verify-android-artifact.mjs");
    const upload = body.indexOf("actions/upload-artifact");
    assert.ok(verify < upload, `${job} must verify before uploading`);
  }
});

test("2. the verifier uses the real SDK tools, not hand-rolled substitutes", () => {
  for (const tool of ["aapt", "apksigner", "zipalign"]) {
    assert.match(apkGate, new RegExp(`tool\\("${tool}"\\)`), `${tool} must be the authority for its check`);
  }
  assert.match(apkGate, /dump", "badging/);
  assert.match(apkGate, /verify", "--verbose", "--print-certs/);
  assert.match(apkGate, /"-c", "-v", "4"/);
  assert.match(apkGate, /process\.exit\(1\)/, "a failed check must stop the build");
  // Skipping a check because a tool is missing is how an unverified APK ships.
  assert.doesNotMatch(apkGate, /skipped because|check was skipped/i);
});

test("3. a debug key can never be published as a release build", () => {
  assert.match(jobBody("android-debug"), /--expect-debug-key/);
  assert.doesNotMatch(jobBody("android-release"), /--expect-debug-key/);
  assert.match(apkGate, /androiddebugkey\|CN=Android Debug/i);
  // The publish job re-checks the recorded result, so a weakened build job cannot
  // slip through on its own.
  assert.match(jobBody("github-release"), /ANDROID_RELEASE_IS_RELEASE_KEY/);
});

test("4. the Capacitor payload is checked before Gradle packages it", () => {
  for (const job of ["android-debug", "android-release"]) {
    const body = jobBody(job);
    assert.match(body, /check-capacitor-bundle\.mjs/);
    assert.ok(body.indexOf("check-capacitor-bundle.mjs") < body.indexOf("assemble"), `${job} must check before assembling`);
  }
  // A dev host baked into a shipped APK is the bug this gate exists to catch:
  // on a phone, localhost is the phone.
  assert.match(bundleGate, /localhost|127\\\.0\\\.0\\\.1/);
  assert.match(bundleGate, /allowMixedContent/);
  assert.match(bundleGate, /cleartext/);
  assert.match(bundleGate, /webContentsDebuggingEnabled/);
});

test("5. Windows signing is gated and can never silently fall back to unsigned", () => {
  const body = jobBody("windows");
  assert.match(body, /needs: windows-signing-available/);
  assert.match(body, /signtool verify \/pa/);
  assert.match(body, /Get-AuthenticodeSignature/);
  assert.match(body, /Status -ne "Valid"/);
  // Required-but-missing must exit 1, not continue.
  assert.match(body, /WINDOWS_SIGNING_REQUIRED is 'true'[\s\S]{0,200}exit 1/);
  assert.match(body, /Refusing to publish an installer that is not verifiably signed[\s\S]{0,80}exit 1/);
  // Timestamping is what keeps a 3-day Artifact Signing certificate verifiable.
  assert.match(body, /timestamp-rfc3161: http:\/\/timestamp\.acs\.microsoft\.com/);
  assert.match(body, /file-digest: SHA256/);
});

test("6. checksums describe the signed bytes, not the pre-signing file", () => {
  const body = jobBody("windows");
  assert.ok(
    body.indexOf("Sign installers") < body.indexOf("Get-FileHash"),
    "the hash must be taken after signing so the published SHA-256 matches the shipped file"
  );
  assert.ok(
    body.indexOf("Get-FileHash") < body.indexOf("actions/upload-artifact"),
    "the checksum must be recorded before the artifact is uploaded"
  );
  assert.match(jobBody("github-release"), /sha256sum -c \.\.\/all\.sha256/);
  assert.match(
    jobBody("github-release"),
    /was attached but never verified at build time/,
    "an asset with no build-time checksum must stop the release"
  );
});

test("7. the release notes only claim a signature that actually exists", () => {
  const body = jobBody("github-release");
  const signedBranch = /if \[ "\$WINDOWS_SIGNED" = "true" \]; then([\s\S]*?)\n              else/.exec(body);
  assert.ok(signedBranch, "the notes must branch on the recorded signing result");
  assert.match(signedBranch[1], /Authenticode-signed/);
  assert.doesNotMatch(signedBranch[1], /not code-signed/);
  const unsignedBranch = /\n              else([\s\S]*?)\n              fi\n              echo/.exec(body);
  assert.ok(unsignedBranch, "the unsigned wording must be reachable");
  assert.match(unsignedBranch[1], /\*\*not code-signed\*\*/);
  assert.doesNotMatch(unsignedBranch[1], /verified publisher|Authenticode-signed and/);
  // A signature is not a reputation claim, even when signing succeeds.
  assert.match(signedBranch[1], /reputation/i);
});

test("8. no step prints a signing secret", () => {
  const probe = jobBody("windows-signing-available");
  assert.match(probe, /echo "mode=\$mode" >> "\$GITHUB_OUTPUT"/);
  // The probe may test presence, but must never echo or summarise a value.
  const secretNames = "TENANT_ID|CLIENT_ID|SUBSCRIPTION_ID|PFX|PFX_PASSWORD";
  assert.doesNotMatch(probe, new RegExp(`echo [^\\n]*\\$\\{?(${secretNames})\\b`));
  assert.doesNotMatch(probe, new RegExp(`GITHUB_STEP_SUMMARY[^\\n]*\\$\\{?(${secretNames})\\b`));
  assert.doesNotMatch(jobBody("signing-available"), /echo "?\$(KEYSTORE|STORE_PASSWORD|KEY_ALIAS|KEY_PASSWORD)/);
  assert.doesNotMatch(workflow, /set -x/);
  // The PFX is written to the runner temp dir and deleted in a finally block.
  assert.match(jobBody("windows"), /Join-Path \$env:RUNNER_TEMP "vupsrouter-authenticode\.pfx"/);
  assert.match(jobBody("windows"), /finally \{[\s\S]*?Remove-Item \$pfx/);
});

test("9. the published release still refuses drafts and unverified tags", () => {
  assert.match(workflow, /--verify-tag/);
  assert.match(workflow, /--latest/);
  assert.doesNotMatch(workflow, /--draft|--prerelease/);
  // Replacing assets on an existing tag must not leave an old unsigned build
  // attached alongside the new one.
  assert.match(workflow, /--clobber/);
});

test("10. the desktop shell may reach the same release lookup as the web app", async () => {
  const rust = read("src-tauri/src/desktop_server.rs");
  const csp = /const HTML_CSP: &str = "([^"]+)"/.exec(rust)?.[1];
  assert.ok(csp, "the local desktop server must set a CSP on its HTML responses");
  const connectSrc = /connect-src([^;]*)/.exec(csp)?.[1] ?? "";
  const { LATEST_RELEASE_API_URL } = await import("../src/download/releases.js");
  assert.ok(
    connectSrc.includes(new URL(LATEST_RELEASE_API_URL).origin),
    "the packaged /download page reads the GitHub Releases API; without it only the desktop build breaks"
  );
  assert.doesNotMatch(connectSrc, /\*/, "connect-src must stay an explicit origin allow-list");
  // ipc.localhost is Tauri's own IPC host; a dev-server origin is not.
  assert.doesNotMatch(csp, /localhost:5173|127\.0\.0\.1:5173/, "the packaged shell must not depend on a dev server");
});
