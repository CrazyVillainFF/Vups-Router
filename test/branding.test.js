import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const publicFile = name => `${root}public/${name}`;
const read = name => readFileSync(publicFile(name));

function pngHeader(name) {
  const buffer = read(name);
  assert.equal(buffer.toString("ascii", 1, 4), "PNG", `${name} is not a PNG`);
  return {
    width: buffer.readUInt32BE(16),
    height: buffer.readUInt32BE(20),
    colorType: buffer[25]
  };
}

test("app logo and launch icons exist at their declared sizes", () => {
  const expected = {
    "vups-logo.png": [512, 512],
    "vups-logo-192.png": [192, 192],
    "apple-touch-icon.png": [180, 180],
    "vups-maskable-512.png": [512, 512],
    "favicon-16.png": [16, 16],
    "favicon-32.png": [32, 32],
    "favicon-48.png": [48, 48],
    "og-vupsrouter.png": [1200, 630]
  };
  for (const [name, [width, height]] of Object.entries(expected)) {
    assert.ok(existsSync(publicFile(name)), `${name} is missing`);
    const header = pngHeader(name);
    assert.equal(header.width, width, `${name} width`);
    assert.equal(header.height, height, `${name} height`);
    assert.ok(statSync(publicFile(name)).size > 0, `${name} is empty`);
  }
  assert.equal(pngHeader("vups-logo.png").colorType, 6, "app logo must keep transparency");
});

test("favicon.ico is a valid multi-size icon", () => {
  const buffer = read("favicon.ico");
  assert.equal(buffer.readUInt16LE(0), 0, "reserved field");
  assert.equal(buffer.readUInt16LE(2), 1, "icon type");
  assert.ok(buffer.readUInt16LE(4) >= 3, "expected at least three icon sizes");
});

test("index.html points at the shipped icon, manifest, and social card", () => {
  const html = readFileSync(`${root}index.html`, "utf8");
  for (const path of [
    "/favicon.ico",
    "/favicon-32.png",
    "/favicon-16.png",
    "/favicon-48.png",
    "/apple-touch-icon.png",
    "/manifest.webmanifest"
  ]) {
    assert.match(html, new RegExp(`href="${path}"`), `missing ${path}`);
  }
  assert.match(html, /<meta name="theme-color" content="#070b14" \/>/);
  assert.match(
    html,
    /<meta property="og:image" content="https:\/\/vups-router-three\.vercel\.app\/og-vupsrouter\.png" \/>/
  );
  assert.match(html, /<meta property="og:image:width" content="1200" \/>/);
  assert.match(html, /<meta property="og:image:height" content="630" \/>/);
  assert.match(html, /<meta name="twitter:card" content="summary_large_image" \/>/);
});

test("manifest icons resolve to real files with matching sizes", () => {
  const manifest = JSON.parse(readFileSync(publicFile("manifest.webmanifest"), "utf8"));
  assert.equal(manifest.display, "standalone");
  assert.equal(manifest.theme_color, "#070b14");
  assert.equal(manifest.background_color, "#070b14");
  assert.equal(manifest.start_url, "/");
  assert.ok(manifest.icons.some(icon => icon.purpose === "maskable"));
  for (const icon of manifest.icons) {
    const name = icon.src.replace(/^\//, "");
    assert.ok(existsSync(publicFile(name)), `${name} is missing`);
    const [width, height] = icon.sizes.split("x").map(Number);
    assert.deepEqual(
      { width: pngHeader(name).width, height: pngHeader(name).height },
      { width, height }
    );
  }
});

test("the shared logo component uses the new mark at both densities", () => {
  const source = readFileSync(`${root}src/components/VupsLogo.jsx`, "utf8");
  assert.match(source, /LOGO_SRC = "\/vups-logo\.png"/);
  assert.match(source, /\/vups-logo-192\.png 192w/);
  assert.match(source, /srcSet=\{LOGO_SRC_SET\}/);
  assert.match(source, /alt=\{alt\}/);
  assert.doesNotMatch(source, /d4ff3f/i);
});
