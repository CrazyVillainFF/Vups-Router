#!/usr/bin/env node
// Builds the Tauri v2 static update manifest (latest.json) that the Windows
// updater reads from GitHub Releases. It pairs the installer download URL with
// the minisign signature `tauri signer` produced over the exact published
// bytes, so the app can verify an update before installing it.
//
// Nothing secret is printed: the signature and key material stay in files and
// JSON; only the version and the output path are logged.
import { readFileSync, writeFileSync } from "node:fs";

function arg(name, required = true) {
  const index = process.argv.indexOf(`--${name}`);
  if (index >= 0 && index + 1 < process.argv.length) return process.argv[index + 1];
  if (required) {
    console.error(`--${name} is required`);
    process.exit(1);
  }
  return "";
}

const signatureFile = arg("signature-file");
const version = arg("version");
const url = arg("url");
const out = arg("out");
const notes = arg("notes", false);
const platform = arg("platform", false) || "windows-x86_64";

const signature = readFileSync(signatureFile, "utf8").trim();
if (!signature) {
  console.error("The signature file is empty.");
  process.exit(1);
}
if (!/^\d+\.\d+\.\d+/.test(version)) {
  console.error("version must be a semantic version such as 1.0.12");
  process.exit(1);
}
let parsed;
try {
  parsed = new URL(url);
} catch {
  console.error("url must be an absolute URL");
  process.exit(1);
}
if (parsed.protocol !== "https:") {
  console.error("url must be https");
  process.exit(1);
}

const manifest = {
  version,
  notes: notes || `VupsRouter ${version}`,
  pub_date: new Date().toISOString(),
  platforms: {
    [platform]: { url, signature }
  }
};

writeFileSync(out, `${JSON.stringify(manifest, null, 2)}\n`);
console.log(`Wrote ${out} for version ${version}.`);
