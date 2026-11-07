// Renders every brand surface from one source SVG: client/public, the PWA
// manifest icons, the Android launcher/splash set and the Tauri window icon.
//
//   node scripts/render-brand.mjs [--source <file.svg>] [--only <name>]
//
// Chrome is used as the rasterizer because it is already on every dev machine
// and it is the only renderer here that keeps the SVG's rounded corners,
// stroke joins and alpha exactly as the browser will paint them.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const clientRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = path.resolve(clientRoot, "..");
const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const at = args.indexOf(`--${name}`);
  return at === -1 ? fallback : args[at + 1];
};
const only = flag("only", null);
const CHROME =
  flag("chrome", null) ||
  (existsSync("C:/Program Files/Google/Chrome/Application/chrome.exe")
    ? "C:/Program Files/Google/Chrome/Application/chrome.exe"
    : "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe");

const sourcePath = path.resolve(
  flag("source", path.join(clientRoot, "public/vups-logo.svg"))
);
const base = readFileSync(sourcePath, "utf8");
const innerMatch = base.match(/<svg[^>]*>([\s\S]*)<\/svg>/i);
if (!innerMatch) throw new Error(`${sourcePath} is not a standalone SVG`);
const inner = innerMatch[1].trim();
const SIZE = 1024;
// Painted extents of the branch mark inside the 1024 box: nodes at y 232..802.
const MARK_CX = 512;
const MARK_CY = 517;

function svg(body) {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${SIZE} ${SIZE}" width="${SIZE}" height="${SIZE}">${body}</svg>`;
}

function scaled(mark, factor) {
  const dx = MARK_CX * (1 - factor);
  const dy = MARK_CY * (1 - factor);
  return `<g transform="translate(${dx} ${dy}) scale(${factor})">${mark}</g>`;
}

// Small sizes lose a 50/1024 stroke to under one device pixel, so the favicon
// and taskbar entries get the same geometry drawn heavier.
const bold = inner
  .replace(/<!-- faded center stem -->\s*<rect[^>]*opacity="0\.35"[^>]*\/\s*/i, "")
  .replace(/stroke-width="50"/g, 'stroke-width="66"')
  .replace(/stroke-width="38"/g, 'stroke-width="50"');

// At 16-48px an open ring is smaller than a pixel and turns to mud, so the
// micro cut keeps the exact branch geometry with the nodes filled solid.
const micro =
  `<rect width="${SIZE}" height="${SIZE}" rx="270" fill="#FF5B1F"/>` +
  `<g stroke="#171613" stroke-width="82" fill="none" stroke-linecap="butt">` +
  `<line x1="330" y1="330" x2="512" y2="612"/><line x1="694" y1="330" x2="512" y2="612"/>` +
  `<line x1="512" y1="580" x2="512" y2="712"/></g>` +
  `<g fill="#171613"><circle cx="312" cy="288" r="56"/><circle cx="512" cy="288" r="56"/>` +
  `<circle cx="712" cy="288" r="56"/><circle cx="512" cy="748" r="52"/></g>`;

// The mark with its tile removed, for the surfaces that must stay transparent.
const untiled = body => body.replace(/^\s*<rect width="\d+" height="\d+"[^>]*\/>\s*/, "");
const monochrome = (body, color) => body.replace(/#[0-9A-Fa-f]{6}/g, color);

// Android paints a notification small icon as an alpha mask over its own
// accent, so the glyph is the micro cut in flat white on nothing.
const status = monochrome(scaled(untiled(micro), 1.4), "#FFFFFF");

const VARIANTS = {
  tile: inner,
  tileBold: bold,
  micro,
  maskable: `<rect width="${SIZE}" height="${SIZE}" fill="#FF5B1F"/>${scaled(untiled(micro), 0.62)}`,
  square: `<rect width="${SIZE}" height="${SIZE}" fill="#FF5B1F"/>${scaled(inner, 0.74)}`,
  circle: `<circle cx="512" cy="512" r="512" fill="#FF5B1F"/>${scaled(inner, 0.8)}`,
  // Adaptive-icon foreground: glyph only, inside the 66dp safe zone.
  glyph: scaled(bold, 0.6),
  // The ink glyph on transparency, used as the metallic-paint texture source.
  transparent: untiled(inner),
  status
};

const write = (file, data) => {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, data);
  return file;
};

const work = mkdtemp();
function mkdtemp() {
  const dir = path.join(os.tmpdir(), `vups-brand-${process.pid}`);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  return dir;
}

for (const [name, body] of Object.entries(VARIANTS)) {
  const markup = name === "tile" ? base : svg(body);
  writeFileSync(path.join(work, `${name}.svg`), markup);
}

function rasterize(variant, width, height, out) {
  const page = path.join(work, `${variant}-${width}x${height}.html`);
  writeFileSync(
    page,
    `<!doctype html><meta charset="utf-8"><style>html,body{margin:0;padding:0;overflow:hidden}` +
      `img{display:block;width:${width}px;height:${height}px}</style>` +
      `<img src="${variant}.svg" alt="">`
  );
  const target = path.join(work, `${path.basename(out)}.${width}x${height}.png`);
  execFileSync(
    CHROME,
    [
      "--headless=new",
      "--disable-gpu",
      "--disable-lcd-text",
      "--hide-scrollbars",
      "--force-device-scale-factor=1",
      "--default-background-color=00000000",
      "--virtual-time-budget=2000",
      `--user-data-dir=${path.join(work, "profile")}`,
      `--screenshot=${target}`,
      `--window-size=${width},${height}`,
      `file:///${page.replace(/\\/g, "/")}`
    ],
    { stdio: "pipe" }
  );
  const png = readFileSync(target);
  if (png.readUInt32BE(16) !== width || png.readUInt32BE(20) !== height) {
    throw new Error(`${out}: Chrome produced ${png.readUInt32BE(16)}x${png.readUInt32BE(20)}`);
  }
  write(out, png);
  return png;
}

// A .ico is a directory of embedded images; PNG payloads are legal and smaller.
function icon(entries) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(entries.length, 4);
  let offset = 6 + 16 * entries.length;
  const dirs = entries.map(({ size, png }) => {
    const dir = Buffer.alloc(16);
    dir.writeUInt8(size >= 256 ? 0 : size, 0);
    dir.writeUInt8(size >= 256 ? 0 : size, 1);
    dir.writeUInt16LE(1, 4);
    dir.writeUInt16LE(32, 6);
    dir.writeUInt32LE(png.length, 8);
    dir.writeUInt32LE(offset, 12);
    offset += png.length;
    return dir;
  });
  return Buffer.concat([header, ...dirs, ...entries.map(entry => entry.png)]);
}

const publicDir = path.join(clientRoot, "public");
const androidRes = path.join(clientRoot, "android/app/src/main/res");
const androidAssets = path.join(clientRoot, "android/app/src/main/assets/public");
const tauriIcons = path.join(clientRoot, "src-tauri/icons");

/* ── jobs ─────────────────────────────────────────────────────────────────── */
const jobs = [];
const job = (name, run) => jobs.push({ name, run });

job("web", () => {
  write(path.join(publicDir, "vups-logo.svg"), base);
  rasterize("tile", 512, 512, path.join(publicDir, "vups-logo.png"));
  rasterize("tile", 192, 192, path.join(publicDir, "vups-logo-192.png"));
  rasterize("transparent", 1024, 1024, path.join(publicDir, "vups-logo-transparent.png"));
  rasterize("maskable", 512, 512, path.join(publicDir, "vups-maskable-512.png"));
  rasterize("square", 180, 180, path.join(publicDir, "apple-touch-icon.png"));
  for (const size of [16, 32, 48]) {
    rasterize("micro", size, size, path.join(publicDir, `favicon-${size}.png`));
  }
  const ico = icon(
    [16, 32, 48].map(size => ({
      size,
      png: rasterize("micro", size, size, path.join(publicDir, `favicon-${size}.png`))
    }))
  );
  write(path.join(publicDir, "favicon.ico"), ico);
});

job("android", () => {
  const densities = { mdpi: 48, hdpi: 72, xhdpi: 96, xxhdpi: 144, xxxhdpi: 192 };
  for (const [dpi, size] of Object.entries(densities)) {
    const dir = path.join(androidRes, `mipmap-${dpi}`);
    rasterize("tile", size, size, path.join(dir, "ic_launcher.png"));
    rasterize("circle", size, size, path.join(dir, "ic_launcher_round.png"));
    // The adaptive foreground canvas is 108dp, so the glyph needs the full bleed.
    rasterize("glyph", Math.round(size * 2.25), Math.round(size * 2.25), path.join(dir, "ic_launcher_foreground.png"));
    // A status-bar icon is 24dp; the platform tints it, so it ships as a mask.
    rasterize("status", Math.round(size / 2), Math.round(size / 2), path.join(androidRes, `drawable-${dpi}`, "ic_stat_vupsrouter.png"));
  }
  write(
    path.join(androidRes, "values/ic_launcher_background.xml"),
    '<?xml version="1.0" encoding="utf-8"?>\n<resources>\n    ' +
      '<color name="ic_launcher_background">#FF5B1F</color>\n</resources>\n'
  );
  const splashes = {
    "drawable-land-mdpi": [480, 320],
    "drawable-land-hdpi": [800, 480],
    "drawable-land-xhdpi": [1280, 720],
    "drawable-land-xxhdpi": [1600, 960],
    "drawable-land-xxxhdpi": [1920, 1280],
    "drawable-port-mdpi": [320, 480],
    "drawable-port-hdpi": [480, 800],
    "drawable-port-xhdpi": [720, 1280],
    "drawable-port-xxhdpi": [960, 1600],
    "drawable-port-xxxhdpi": [1280, 1920]
  };
  for (const [dir, [width, height]] of Object.entries(splashes)) {
    splash(width, height, path.join(androidRes, dir, "splash.png"));
  }
  // The unqualified bucket is what Android falls back to when no
  // orientation/density combination matches, so it must carry the mark too.
  splash(480, 320, path.join(androidRes, "drawable", "splash.png"));
  // The web bundle Capacitor copies into the APK carries the same icons,
  // social card and install chrome.
  for (const file of [
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
  ]) {
    const from = path.join(publicDir, file);
    if (existsSync(from)) write(path.join(androidAssets, file), readFileSync(from));
  }
});

function splash(width, height, out) {
  const page = path.join(work, `splash-${width}x${height}.html`);
  const tile = Math.round(Math.min(width, height) * 0.28);
  writeFileSync(
    page,
    `<!doctype html><meta charset="utf-8"><style>html,body{margin:0;padding:0;width:${width}px;height:${height}px;` +
      `background:#0F0E0C;display:flex;align-items:center;justify-content:center;overflow:hidden}` +
      `img{display:block;width:${tile}px;height:${tile}px;border-radius:${Math.round(tile * 0.263)}px}` +
      `</style><img src="tile.svg" alt="">`
  );
  const target = path.join(work, `splash-${width}x${height}.png`);
  execFileSync(
    CHROME,
    [
      "--headless=new",
      "--disable-gpu",
      "--hide-scrollbars",
      "--force-device-scale-factor=1",
      "--virtual-time-budget=2000",
      `--user-data-dir=${path.join(work, "profile")}`,
      `--screenshot=${target}`,
      `--window-size=${width},${height}`,
      `file:///${page.replace(/\\/g, "/")}`
    ],
    { stdio: "pipe" }
  );
  write(out, readFileSync(target));
}

job("windows", () => {
  rasterize("tile", 512, 512, path.join(tauriIcons, "icon.png"));
  const entries = [];
  for (const size of [16, 32, 48, 64, 128, 256]) {
    const variant = size <= 48 ? "micro" : "tile";
    entries.push({ size, png: rasterize(variant, size, size, path.join(work, `win-${size}.png`)) });
  }
  write(path.join(tauriIcons, "icon.ico"), icon(entries));
});

job("social", () => {
  const [width, height] = [1200, 630];
  const page = path.join(work, "og.html");
  writeFileSync(
    page,
    `<!doctype html><meta charset="utf-8"><style>
      *{box-sizing:border-box;margin:0;padding:0}
      html,body{width:${width}px;height:${height}px;overflow:hidden}
      body{background:#0F0E0C;color:#EDEAE3;font-family:"Geist","Segoe UI",system-ui,sans-serif;
        position:relative;padding:52px 64px;display:flex;flex-direction:column;justify-content:space-between}
      body:before{content:"";position:absolute;inset:0;
        background-image:linear-gradient(#2A2824 1px,transparent 1px),linear-gradient(90deg,#2A2824 1px,transparent 1px);
        background-size:48px 48px;opacity:.35}
      .row,.hero,.foot{position:relative}
      .row{display:flex;align-items:center;justify-content:space-between}
      .brand{display:flex;align-items:center;gap:14px}
      .brand img{width:52px;height:52px;border-radius:14px}
      .brand b{font-size:26px;font-weight:600;letter-spacing:-.02em}
      .brand b span{font-weight:300;color:#8F8B82}
      .kicker{font:500 13px/1 "Consolas",ui-monospace,monospace;letter-spacing:.22em;color:#8F8B82;text-transform:uppercase}
      .eyebrow{font:500 13px/1 "Consolas",ui-monospace,monospace;letter-spacing:.22em;color:#8F8B82;margin-bottom:24px}
      h1{font-family:"Instrument Serif","Iowan Old Style",Georgia,serif;font-weight:400;
        font-size:82px;line-height:1.02;letter-spacing:-.025em;max-width:900px}
      h1 em{font-style:italic;color:#FF5B1F}
      p{margin-top:24px;max-width:560px;font-size:21px;line-height:1.5;color:#8F8B82}
      .foot{display:flex;justify-content:space-between;align-items:flex-end;
        padding-top:20px;border-top:1px solid #2A2824;
        font:500 12px/1 "Consolas",ui-monospace,monospace;letter-spacing:.16em;color:#8F8B82;text-transform:uppercase}
    </style>
    <div class="row">
      <div class="brand"><img src="tile.svg" alt=""><b>vups<span>router</span></b></div>
      <div class="kicker">AI chat / model routing</div>
    </div>
    <div class="hero">
      <div class="eyebrow">VupsRouter AI</div>
      <h1>Ask once.<br>We pick the <em>block.</em></h1>
      <p>Chat, build and route every request through one calm, focused workspace.</p>
    </div>
    <div class="foot"><span>VupsRouter AI · Free to start</span><span>vups-router-three.vercel.app</span></div>`
  );
  const target = path.join(work, "og.png");
  execFileSync(
    CHROME,
    [
      "--headless=new",
      "--disable-gpu",
      "--disable-lcd-text",
      "--hide-scrollbars",
      "--force-device-scale-factor=1",
      "--virtual-time-budget=4000",
      `--user-data-dir=${path.join(work, "profile")}`,
      `--screenshot=${target}`,
      `--window-size=${width},${height}`,
      `file:///${page.replace(/\\/g, "/")}`
    ],
    { stdio: "pipe" }
  );
  write(path.join(publicDir, "og-vupsrouter.png"), readFileSync(target));
});

// The Android bundle copies the social card out of public/, so it has to be
// rendered before that job runs regardless of where it is declared.
const ORDER = ["web", "social", "android", "windows"];
const selected = (only ? jobs.filter(entry => entry.name === only) : jobs).sort(
  (a, b) => ORDER.indexOf(a.name) - ORDER.indexOf(b.name)
);
if (!selected.length) throw new Error(`--only ${only} matched nothing (${jobs.map(j => j.name)})`);
for (const entry of selected) {
  const started = Date.now();
  entry.run();
  console.log(`${entry.name}: done in ${((Date.now() - started) / 1000).toFixed(1)}s`);
}
rmSync(work, { recursive: true, force: true });
