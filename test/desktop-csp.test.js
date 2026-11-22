import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = file => readFileSync(path.join(root, file), "utf8");

const server = read("src-tauri/src/desktop_server.rs");
const csp = /const HTML_CSP: &str = "([^"]+)"/.exec(server)?.[1];

function directives(policy) {
  const map = new Map();
  for (const part of policy.split(";")) {
    const tokens = part.trim().split(/\s+/).filter(Boolean);
    if (tokens.length) map.set(tokens[0], tokens.slice(1));
  }
  return map;
}

// The browser hashes the script text after the HTML input stream normalizes
// newlines, so a CRLF checkout hashes differently from the bytes on disk.
function inlineScripts(html) {
  const rows = [];
  const re = /<script([^>]*)>([\s\S]*?)<\/script>/g;
  let match;
  while ((match = re.exec(html))) {
    if (/\bsrc\s*=/.test(match[1])) continue;
    rows.push(match[2].replace(/\r\n?/g, "\n"));
  }
  return rows;
}

const scriptHash = text => `sha256-${createHash("sha256").update(text, "utf8").digest("base64")}`;

test("the desktop shell defines one CSP and sends it on the HTML it serves", () => {
  assert.ok(csp, "desktop_server.rs must define HTML_CSP");
  assert.match(server, /HeaderValue::from_static\(HTML_CSP\)/);
});

test("the pre-first-paint theme bootstrap is authorized by its own hash", () => {
  const scripts = inlineScripts(read("index.html"));
  assert.equal(scripts.length, 1, "index.html carries exactly one inline script: the theme bootstrap");
  assert.match(scripts[0], /Pre-first-paint theme bootstrap/);
  const scriptSrc = directives(csp).get("script-src") || [];
  assert.ok(
    scriptSrc.includes(`'${scriptHash(scripts[0])}'`),
    `script-src must authorize ${scriptHash(scripts[0])}; the packaged window otherwise paints the default palette before the stored theme`
  );
});

test("authorizing the bootstrap never opens inline scripting to everything", () => {
  const scriptSrc = directives(csp).get("script-src") || [];
  assert.ok(scriptSrc.includes("'self'"));
  assert.ok(!scriptSrc.includes("'unsafe-inline'"), "script-src must not allow arbitrary inline script");
  assert.ok(!scriptSrc.includes("'unsafe-eval'"), "script-src must not allow eval");
  assert.ok(!scriptSrc.some(token => token === "*" || token === "https:" || token === "http:"), "script-src must not allow a whole scheme");
});

test("the window still reaches only itself, the IPC bridge and the local model runtime", () => {
  const connectSrc = directives(csp).get("connect-src") || [];
  for (const allowed of ["'self'", "ipc:", "http://ipc.localhost", "http://127.0.0.1:11434", "http://localhost:11434"]) {
    assert.ok(connectSrc.includes(allowed), `connect-src must keep ${allowed}`);
  }
  assert.ok(!connectSrc.includes("*"), "connect-src must not be a wildcard");
  assert.ok(!connectSrc.includes("'unsafe-inline'"));
});

test("the rest of the policy keeps the frame and object locks the shell relies on", () => {
  const map = directives(csp);
  assert.deepEqual(map.get("object-src"), ["'none'"]);
  assert.deepEqual(map.get("base-uri"), ["'self'"]);
  assert.deepEqual(map.get("form-action"), ["'self'"]);
  assert.deepEqual(map.get("frame-ancestors"), ["'none'"]);
  assert.deepEqual(map.get("default-src"), ["'self'"]);
});