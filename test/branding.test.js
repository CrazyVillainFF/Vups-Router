import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync, statSync, readdirSync } from "node:fs";
import zlib from "node:zlib";
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

/* ── decoded-pixel guards ──────────────────────────────────────────────────
   A raster can keep its filename, its dimensions and its timestamp while still
   painting yesterday's mark, which is exactly how the old splash survived the
   last rebrand. Every packaged brand image is therefore inflated here and its
   pixels are compared against the palette the previous logo was built from. */

// The node colors of the superseded mark (git: "add electric Vups logo").
const OLD_MARK = ["#16a34a", "#3b82f6", "#ef4444", "#14532d", "#86efac"].map(hexToRgb);
const BRAND_ORANGE = hexToRgb("#ff5b1f");
const INK = hexToRgb("#171613");
const TOLERANCE = 14;

function hexToRgb(hex) {
  const value = parseInt(hex.slice(1), 16);
  return [(value >> 16) & 255, (value >> 8) & 255, value & 255];
}

function decodePng(buffer) {
  let pos = 8;
  let width = 0;
  let height = 0;
  let depth = 0;
  let color = 0;
  const parts = [];
  while (pos < buffer.length) {
    const len = buffer.readUInt32BE(pos);
    const type = buffer.toString("ascii", pos + 4, pos + 8);
    const data = buffer.subarray(pos + 8, pos + 8 + len);
    if (type === "IHDR") {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      depth = data[8];
      color = data[9];
    }
    if (type === "IDAT") parts.push(Buffer.from(data));
    if (type === "IEND") break;
    pos += 12 + len;
  }
  assert.equal(depth, 8, "brand rasters are 8-bit");
  const channels = { 0: 1, 2: 3, 4: 2, 6: 4 }[color];
  assert.ok(channels, `unsupported PNG colour type ${color}`);
  const raw = zlib.inflateSync(Buffer.concat(parts));
  const stride = width * channels;
  const pixels = Buffer.alloc(stride * height);
  let at = 0;
  for (let y = 0; y < height; y++) {
    const filter = raw[at++];
    for (let x = 0; x < stride; x++) {
      const value = raw[at++];
      const left = x >= channels ? pixels[y * stride + x - channels] : 0;
      const up = y > 0 ? pixels[(y - 1) * stride + x] : 0;
      const upLeft = y > 0 && x >= channels ? pixels[(y - 1) * stride + x - channels] : 0;
      let guess;
      if (filter === 0) guess = value;
      else if (filter === 1) guess = value + left;
      else if (filter === 2) guess = value + up;
      else if (filter === 3) guess = value + ((left + up) >> 1);
      else {
        const p = left + up - upLeft;
        const pa = Math.abs(p - left);
        const pb = Math.abs(p - up);
        const pc = Math.abs(p - upLeft);
        guess = value + (pa <= pb && pa <= pc ? left : pb <= pc ? up : upLeft);
      }
      pixels[y * stride + x] = guess & 0xff;
    }
  }
  return { width, height, channels, pixels };
}

// An .ico is a directory of embedded images; this build stores PNG payloads.
function decodeRasters(file) {
  const buffer = readFileSync(file);
  if (buffer.toString("ascii", 1, 4) === "PNG") return [decodePng(buffer)];
  assert.equal(buffer.readUInt16LE(2), 1, `${file} is not an icon`);
  const count = buffer.readUInt16LE(4);
  const images = [];
  for (let i = 0; i < count; i++) {
    const offset = buffer.readUInt32LE(6 + i * 16 + 12);
    const size = buffer.readUInt32LE(6 + i * 16 + 8);
    images.push(decodePng(buffer.subarray(offset, offset + size)));
  }
  return images;
}

function eachPixel(image, visit) {
  const { channels, pixels } = image;
  let opaque = 0;
  for (let i = 0; i < pixels.length; i += channels) {
    const alpha = channels === 4 ? pixels[i + 3] : 255;
    if (alpha < 8) continue;
    opaque++;
    visit(pixels[i], pixels[i + 1], pixels[i + 2]);
  }
  return opaque;
}

const near = (a, b) => Math.abs(a - b) <= TOLERANCE;
const matches = (r, g, b, tint) => near(r, tint[0]) && near(g, tint[1]) && near(b, tint[2]);

const OLD_BIT = 1;
const COLD_BIT = 2;
const ORANGE_BIT = 4;
const INK_BIT = 8;

function classify(r, g, b) {
  let bits = 0;
  if (OLD_MARK.some(tint => matches(r, g, b, tint))) bits |= OLD_BIT;
  /* The shell the old mark was built on: a blue-dominant dark, never the warm
     ink the token table paints. This is what a downscaled old logo looks like
     once its node colors have blurred together. */
  if (b >= r + 12 && b >= 24) bits |= COLD_BIT;
  if (matches(r, g, b, BRAND_ORANGE)) bits |= ORANGE_BIT;
  if (matches(r, g, b, INK)) bits |= INK_BIT;
  return bits;
}

function audit(file) {
  const images = decodeRasters(file.startsWith(root) ? file : `${root}${file}`);
  const counts = { old: 0, cold: 0, orange: 0, ink: 0, total: 0 };
  for (const image of images) {
    counts.total += image.width * image.height;
    eachPixel(image, (r, g, b) => {
      const bits = classify(r, g, b);
      if (bits & OLD_BIT) counts.old++;
      if (bits & COLD_BIT) counts.cold++;
      if (bits & ORANGE_BIT) counts.orange++;
      if (bits & INK_BIT) counts.ink++;
    });
  }
  return { ...counts, images };
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
  /* The manifest chrome has to agree with the token table, because a PWA or
     installed web app paints these before the stylesheet loads. Read from
     tokens.css so the value cannot drift back to the old navy shell. */
  const darkBg = /--bg:\s*(#[0-9a-f]{6})/i.exec(readFileSync(`${root}src/tokens.css`, "utf8"))[1];
  assert.equal(manifest.theme_color, darkBg);
  assert.equal(manifest.background_color, darkBg);
  assert.doesNotMatch(`${manifest.theme_color}${manifest.background_color}`, /070b14/i);
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
    if (dir !== "drawable" && !dir.startsWith("drawable-")) continue;
    const splash = `${root}android/app/src/main/res/${dir}/splash.png`;
    if (!existsSync(splash)) continue;
    assert.equal(pngHeaderAt(splash).colorType, 2, "splash art is a flat tile, not a photo");
  }
  assert.equal(pngHeaderAt(`${root}src-tauri/icons/icon.png`).width, 512);
  const ico = readFileSync(`${root}src-tauri/icons/icon.ico`);
  assert.ok(ico.readUInt16LE(4) >= 3, "desktop icon needs multiple sizes");
});

/* ── packaged-pixel pass ───────────────────────────────────────────────────
   §4 is only satisfied when the mark that ships is the mark that is painted,
   so these walk the real files inside the Android and Windows packages rather
   than trusting a filename or a timestamp. */

const resDir = `${root}android/app/src/main/res`;
const androidWeb = `${root}android/app/src/main/assets/public`;

function packagedBrandRasters() {
  const files = [
    "public/vups-logo.png",
    "public/vups-logo-192.png",
    "public/vups-maskable-512.png",
    "public/apple-touch-icon.png",
    "public/favicon-16.png",
    "public/favicon-32.png",
    "public/favicon-48.png",
    "public/og-vupsrouter.png",
    "src-tauri/icons/icon.png",
    "src-tauri/icons/icon.ico"
  ];
  for (const dir of readdirSync(resDir)) {
    if (!dir.startsWith("mipmap-") && !dir.startsWith("drawable")) continue;
    for (const name of readdirSync(`${resDir}/${dir}`)) {
      if (!name.endsWith(".png")) continue;
      files.push(`android/app/src/main/res/${dir}/${name}`);
    }
  }
  for (const name of readdirSync(androidWeb)) {
    if (/^(vups-|favicon|apple-|og-)/.test(name) && name.endsWith(".png")) {
      files.push(`android/app/src/main/assets/public/${name}`);
    }
  }
  return files;
}

test("the stale-mark detector detects it", () => {
  // The colors below are the measured palette of the old splash that this
  // guard was written to catch: a navy shell with a dark blue mark.
  assert.equal(classify(0x08, 0x12, 0x21) & COLD_BIT, COLD_BIT, "navy shell");
  assert.equal(classify(0x10, 0x18, 0x40) & COLD_BIT, COLD_BIT, "old blue mark");
  assert.equal(classify(0x3b, 0x82, 0xf6) & (COLD_BIT | OLD_BIT), COLD_BIT | OLD_BIT, "old node");
  assert.equal(classify(0x0f, 0x0e, 0x0c) & (COLD_BIT | ORANGE_BIT), 0, "warm ink is not stale");
  assert.equal(classify(0xff, 0x5b, 0x1f) & ORANGE_BIT, ORANGE_BIT, "brand tile");
});

test("no packaged brand raster still paints the superseded mark", () => {
  const files = packagedBrandRasters();
  assert.ok(files.length > 40, `the walk found only ${files.length} images`);
  const stale = [];
  for (const file of files) {
    const { old, cold } = audit(file);
    if (old > 0 || cold > 0) stale.push(`${file}: old=${old} cold=${cold}`);
  }
  assert.deepEqual(stale, [], "these packaged images still contain the old logo palette");
});

test("every tile surface is painted with the brand orange and the ink mark", () => {
  for (const file of packagedBrandRasters()) {
    const name = file.split("/").pop();
    if (name === "ic_stat_vupsrouter.png" || name === "vups-logo-transparent.png") continue;
    const { orange, ink } = audit(file);
    assert.ok(orange > 0, `${file} carries no brand tile`);
    assert.ok(ink > 0, `${file} carries no branch mark`);
  }
});

test("the notification small icon is the brand glyph as a white mask", () => {
  const sizes = { mdpi: 24, hdpi: 36, xhdpi: 48, xxhdpi: 72, xxxhdpi: 96 };
  for (const [dpi, size] of Object.entries(sizes)) {
    const file = `${resDir}/drawable-${dpi}/ic_stat_vupsrouter.png`;
    assert.ok(existsSync(file), `${dpi} has no notification icon`);
    const image = decodePng(readFileSync(file));
    assert.deepEqual({ width: image.width, height: image.height }, { width: size, height: size });
    assert.equal(image.channels, 4, "a status icon needs its own alpha");
    let white = 0;
    let painted = 0;
    eachPixel(image, (r, g, b) => {
      painted++;
      if (r > 235 && g > 235 && b > 235) white++;
    });
    assert.ok(painted > size, `${dpi} icon is empty`);
    assert.equal(white, painted, `${dpi} icon is not a flat mask`);
  }
  const java = readFileSync(
    `${root}android/app/src/main/java/com/vupsrouter/app/downloads/DownloadService.java`,
    "utf8"
  );
  assert.match(java, /setSmallIcon\(com\.vupsrouter\.app\.R\.drawable\.ic_stat_vupsrouter\)/);
  assert.doesNotMatch(java, /android\.R\.drawable\.stat_(sys_download|notify)/);
});

test("the mark shipped inside the Android web bundle is the file in public", () => {
  const bundled = [
    "vups-logo.svg",
    "vups-logo.png",
    "vups-logo-192.png",
    "vups-logo-transparent.png",
    "vups-maskable-512.png",
    "apple-touch-icon.png",
    "favicon.ico",
    "favicon-16.png",
    "favicon-32.png",
    "favicon-48.png",
    "og-vupsrouter.png",
    "manifest.webmanifest"
  ];
  for (const name of bundled) {
    assert.ok(existsSync(publicFile(name)), `public/${name} is missing`);
    const copy = `${androidWeb}/${name}`;
    assert.ok(existsSync(copy), `${name} is not in the Android bundle`);
    assert.deepEqual(
      [...readFileSync(copy)],
      [...readFileSync(publicFile(name))],
      `${name} differs between public/ and the packaged bundle`
    );
  }
});

test("the transparent mark and the template launcher art are as the pipeline leaves them", () => {
  const transparent = audit("public/vups-logo-transparent.png");
  assert.equal(transparent.images[0].width, 1024);
  assert.equal(transparent.orange, 0, "the metallic-paint texture is the glyph, not the tile");
  assert.ok(transparent.ink > 1000, "the texture has no mark in it");

  // The IDE templates shipped a bugdroid background and foreground that no
  // resource actually references any more; leaving them in the tree is how a
  // stale mark gets picked back up by the next build.
  assert.ok(!existsSync(`${resDir}/drawable/ic_launcher_background.xml`), "template background is dead art");
  assert.ok(!existsSync(`${resDir}/drawable-v24/ic_launcher_foreground.xml`), "template foreground is dead art");
  const adaptive = readFileSync(`${resDir}/mipmap-anydpi-v26/ic_launcher.xml`, "utf8");
  assert.match(adaptive, /@color\/ic_launcher_background/);
  assert.match(adaptive, /@mipmap\/ic_launcher_foreground/);
  assert.doesNotMatch(adaptive, /@drawable\/ic_launcher_/);
});

test("one script emits every brand surface", () => {
  const script = readFileSync(`${root}scripts/render-brand.mjs`, "utf8");
  for (const emitted of [
    '"vups-logo.svg"',
    '"vups-logo.png"',
    '"vups-logo-transparent.png"',
    '"vups-maskable-512.png"',
    '"apple-touch-icon.png"',
    '"favicon.ico"',
    '"og-vupsrouter.png"',
    '"manifest.webmanifest"',
    '"ic_launcher.png"',
    '"ic_launcher_round.png"',
    '"ic_launcher_foreground.png"',
    '"ic_stat_vupsrouter.png"',
    'androidRes, "drawable", "splash.png"'
  ]) {
    assert.ok(script.includes(emitted), `${emitted} is not produced by the brand pipeline`);
  }
  // Nothing may hand-write a mark: the SVG is the only source.
  assert.match(script, /public\/vups-logo\.svg/);
});
