import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync, statSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const publicFile = name => `${root}public/${name}`;
const read = name => readFileSync(publicFile(name));

function pngHeaderAt(file) {
  const buffer = readFileSync(file);
  assert.equal(buffer.toString("ascii", 1, 4), "PNG", `${file} is not a PNG`);
  return {
    width: buffer.readUInt32BE(16),
    height: buffer.readUInt32BE(20),
    colorType: buffer[25]
  };
}

function pngHeader(name) {
  return pngHeaderAt(publicFile(name));
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
  assert.match(html, /<meta name="theme-color" content="" \/>/);
  /* Mobile browsers tint their chrome from theme-color; tokens.css and src/main.jsx keep the hex there, so this is a no-op placeholder in HTML. */
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

test("the one logo source paints the mark in the Blocks palette only", () => {
  const svg = readFileSync(publicFile("vups-logo.svg"), "utf8");
  const hexes = new Set((svg.match(/#[0-9a-fA-F]{3,8}/g) ?? []).map(hex => hex.toUpperCase()));
  assert.deepEqual([...hexes].sort(), ["#171613", "#FF5B1F"], "the mark may only use the tile and ink tokens");
  assert.equal((svg.match(/<circle/g) ?? []).length, 4, "three branch nodes plus the routed node");
  assert.equal((svg.match(/<line/g) ?? []).length, 3, "two angled branches plus the stem");
});

test("the same mark ships on the Android launcher, splash and desktop icon", () => {
  const mipmaps = { mdpi: 48, hdpi: 72, xhdpi: 96, xxhdpi: 144, xxxhdpi: 192 };
  for (const [dpi, size] of Object.entries(mipmaps)) {
    for (const name of ["ic_launcher.png", "ic_launcher_round.png"]) {
      const file = `${root}android/app/src/main/res/mipmap-${dpi}/${name}`;
      assert.ok(existsSync(file), `${dpi}/${name} is missing`);
      const header = pngHeaderAt(file);
      assert.deepEqual({ width: header.width, height: header.height }, { width: size, height: size });
      assert.equal(header.colorType, 6, `${dpi}/${name} must stay transparent`);
    }
    // Adaptive icons need the foreground drawn on the 108dp canvas, scaled by density.
    const foreground = pngHeaderAt(`${root}android/app/src/main/res/mipmap-${dpi}/ic_launcher_foreground.png`);
    assert.equal(foreground.width, Math.round(size * 2.25), `${dpi} foreground breaks out of the safe zone`);
  }
  const background = readFileSync(`${root}android/app/src/main/res/values/ic_launcher_background.xml`, "utf8");
  assert.match(background, /<color name="ic_launcher_background">#FF5B1F<\/color>/);
  assert.doesNotMatch(background, /#FFFFFF/);
  for (const dir of readdirSync(`${root}android/app/src/main/res`)) {
    if (!dir.startsWith("drawable-")) continue;
    const splash = `${root}android/app/src/main/res/${dir}/splash.png`;
    if (!existsSync(splash)) continue;
    assert.equal(pngHeaderAt(splash).colorType, 2, "splash art is a flat tile, not a photo");
  }
  assert.equal(pngHeaderAt(`${root}src-tauri/icons/icon.png`).width, 512);
  const ico = readFileSync(`${root}src-tauri/icons/icon.ico`);
  assert.ok(ico.readUInt16LE(4) >= 3, "desktop icon needs multiple sizes");
});
