import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  FOLDER_CONTENT_LIMITS,
  buildFolderTree,
  folderAttachmentFromReport,
  folderExclusionStats,
  planFolderSelection,
  prepareFolderAttachment
} from "../src/chat/folderAttachments.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = file => readFileSync(path.join(root, file), "utf8");

// Node ships File/Blob and atob but not FileReader; the browser image pipeline
// only needs the data-URL read, so provide the minimal shim for this suite.
if (typeof globalThis.FileReader === "undefined") {
  globalThis.FileReader = class FileReader {
    readAsDataURL(blob) {
      blob.arrayBuffer().then(
        buffer => {
          let binary = "";
          for (const byte of new Uint8Array(buffer)) binary += String.fromCharCode(byte);
          this.result = `data:${blob.type || "application/octet-stream"};base64,${btoa(binary)}`;
          this.onload?.();
        },
        error => {
          this.error = error;
          this.onerror?.();
        }
      );
    }
  };
}

const PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";

const ENTRIES = [
  { path: "README.md", size: 12, kind: "text" },
  { path: "src/app.js", size: 24, kind: "text" },
  { path: "src/styles.css", size: 18, kind: "text" },
  { path: "assets/logo.png", size: 68, kind: "image" },
  { path: "manual.pdf", size: 400, kind: "other" },
  { path: ".env", size: 8, kind: "text" }
];

function report(overrides = {}) {
  return {
    path: "C:/work/demo",
    name: "demo",
    token: "token-1",
    totalFiles: 6,
    supportedFiles: 4,
    totalBytes: 530,
    entries: ENTRIES,
    excluded: [{ path: "node_modules/", reason: "Generated or dependency directory — not scanned." }],
    unreadable: 0,
    truncated: false,
    limits: { maxFiles: 5000 },
    ...overrides
  };
}

test("buildFolderTree keeps the real hierarchy and truncates by entries", () => {
  const tree = buildFolderTree(ENTRIES, "demo", 6);
  assert.match(tree.text, /^demo\/$/m);
  assert.match(tree.text, /src\/$/m);
  assert.match(tree.text, /app\.js/);
  assert.match(tree.text, /styles\.css/);
  assert.match(tree.text, /assets\/$/m);
  assert.match(tree.text, /logo\.png/);
  assert.equal(tree.total, ENTRIES.length);
  assert.equal(tree.shown, ENTRIES.length);
  assert.equal(tree.truncated, false);

  const clipped = buildFolderTree(ENTRIES, "demo", 5);
  assert.equal(clipped.shown, 5);
  assert.equal(clipped.truncated, true);
  assert.match(clipped.text, /and 1 more entry\b/);
});

test("planFolderSelection names every skip reason without reading content", () => {
  const folder = folderAttachmentFromReport(report());
  const plan = folder.readPlan;
  assert.deepEqual(plan.text.sort(), ["README.md", "src/app.js", "src/styles.css"]);
  assert.deepEqual(plan.images, ["assets/logo.png"]);
  assert.ok(plan.skipped.some(entry => entry.path === "manual.pdf" && /Unsupported/.test(entry.reason)));
  assert.ok(plan.skipped.some(entry => entry.path === ".env" && /Secret/.test(entry.reason)));
});

test("planFolderSelection applies explicit text and image limits", () => {
  const folder = folderAttachmentFromReport(report());
  const plan = planFolderSelection(folder, {
    ...FOLDER_CONTENT_LIMITS,
    textFiles: 1,
    images: 0
  });
  assert.deepEqual(plan.text, ["README.md"]);
  assert.deepEqual(plan.images, []);
  assert.ok(plan.skipped.some(entry => /1 text files are included/.test(entry.reason)));
  assert.ok(plan.skipped.some(entry => /0 images are attached/.test(entry.reason)));
});

test("planFolderSelection lists every image left out by the per-message cap", () => {
  const entries = Array.from({ length: 12 }, (_, index) => ({
    path: `assets/photo-${index + 1}.png`,
    size: 68,
    kind: "image"
  }));
  const folder = folderAttachmentFromReport(
    report({ totalFiles: 12, supportedFiles: 12, totalBytes: 816, entries, excluded: [] })
  );
  assert.equal(folder.readPlan.images.length, 10);
  const capped = folder.readPlan.skipped.filter(entry => /10 images are attached/.test(entry.reason));
  assert.deepEqual(
    capped.map(entry => entry.path),
    ["assets/photo-11.png", "assets/photo-12.png"]
  );
});

test("a 40-file folder accounts for every file before send", () => {
  const textEntries = Array.from({ length: 29 }, (_, index) => ({
    path: `src/text-${index + 1}.js`,
    size: 100,
    kind: "text"
  }));
  const imageEntries = Array.from({ length: 10 }, (_, index) => ({
    path: `assets/photo-${index + 1}.png`,
    size: 68,
    kind: "image"
  }));
  const folder = folderAttachmentFromReport(
    report({
      name: "Portfolio",
      totalFiles: 40,
      supportedFiles: 39,
      totalBytes: 3580,
      entries: [...textEntries, ...imageEntries],
      excluded: [
        { path: "Portfolio BD/.env", reason: "Secret file — not read automatically.", kind: "secret" },
        { path: "node_modules/", reason: "Generated or dependency directory — not scanned.", kind: "directory" }
      ]
    })
  );
  const plan = folder.readPlan;
  assert.equal(folder.fileCount, 40);
  assert.equal(plan.text.length, 29);
  assert.equal(plan.images.length, 10, "all ten images fit the new per-message cap");
  assert.equal(plan.skipped.length, 0);
  assert.equal(plan.text.length + plan.images.length + 1, folder.fileCount);
  const stats = folderExclusionStats(folder);
  assert.equal(stats.directories.length, 1);
  assert.equal(stats.secretFiles.length, 1, "secret files stay opt-in");
});

test("secret and generated opt-ins include every file", () => {
  const entries = [
    { path: "src/app.js", size: 20, kind: "text" },
    { path: ".env", size: 12, kind: "text" },
    { path: "node_modules/pkg/index.js", size: 30, kind: "text" }
  ];
  const folder = folderAttachmentFromReport(
    report({
      totalFiles: 3,
      supportedFiles: 3,
      totalBytes: 62,
      entries,
      excluded: [],
      options: { includeSecrets: true, includeGenerated: true }
    })
  );
  assert.deepEqual(folder.readPlan.text.sort(), [".env", "node_modules/pkg/index.js", "src/app.js"]);
  assert.equal(folder.readPlan.skipped.length, 0);
  assert.equal(folderExclusionStats(folder).total, 0);
});

test("secret files are skipped with an opt-in reason until enabled", () => {
  const entries = [{ path: ".env", size: 12, kind: "secret" }];
  const folder = folderAttachmentFromReport(
    report({ totalFiles: 1, supportedFiles: 0, totalBytes: 12, entries, excluded: [] })
  );
  assert.equal(folder.readPlan.text.length, 0);
  assert.match(folder.readPlan.skipped[0].reason, /Include secret files/);
});

test("same-named files, unicode names, and Windows separators stay distinct", () => {
  const entries = [
    { path: "a/index.html", size: 10, kind: "text" },
    { path: "b/index.html", size: 20, kind: "text" },
    { path: "src/naïve file.js", size: 30, kind: "text" },
    { path: "src\\win\\App.jsx", size: 40, kind: "text" }
  ];
  const folder = folderAttachmentFromReport(
    report({ totalFiles: 4, supportedFiles: 4, totalBytes: 100, entries, excluded: [] })
  );
  assert.equal(folder.readPlan.text.length, 4);
  assert.deepEqual(
    folder.readPlan.text.slice().sort(),
    ["a/index.html", "b/index.html", "src/naïve file.js", "src\\win\\App.jsx"].sort()
  );
  assert.match(folder.tree, /naïve file\.js/);
  assert.match(folder.tree, /App\.jsx/);
});

test("a folder attachment is metadata only and keeps one card", () => {
  const folder = folderAttachmentFromReport(report());
  assert.equal(folder.kind, "folder");
  assert.equal(folder.status, "ready");
  assert.equal(folder.fileCount, 6);
  assert.equal(folder.token, "token-1");
  assert.match(folder.tree, /src\//);
  assert.equal(folder.readPlan.text.length, 3);
  assert.equal(folder.entries, ENTRIES, "entries stay as metadata for the read plan");
  assert.equal(folder.text, undefined, "no file content is read at selection time");
  assert.equal(folder.scanLimit, 5000);
});

test("prepareFolderAttachment reads lazily, in bounded batches, with progress", async () => {
  const folder = folderAttachmentFromReport(report());
  const batches = [];
  const progress = [];
  const result = await prepareFolderAttachment(folder, {
    readFiles: async (token, paths) => {
      assert.equal(token, "token-1");
      batches.push(paths);
      return paths.map(current =>
        current.endsWith(".png")
          ? { kind: "image", path: current, mimeType: "image/png", base64: PNG_BASE64, size: 68 }
          : { kind: "text", path: current, text: `contents of ${current}`, size: 30 }
      );
    },
    onProgress: update => progress.push(update)
  });

  assert.ok(batches.length >= 1);
  for (const batch of batches) assert.ok(batch.length <= 4, "reads are batched four at a time");
  assert.equal(batches.flat().length, 4, "three text files and one image are read");
  assert.equal(progress.at(-1).processed, progress.at(-1).total);

  const context = result.items[0];
  assert.equal(context.source, "folder-context");
  assert.match(context.text, /Folder: demo/);
  assert.match(context.text, /src\/$/m);
  assert.match(context.text, /Included in this message: 3 text files and 1 image/);
  assert.match(context.text, /Excluded without reading/);

  const textItems = result.items.filter(item => item.kind === "text" && item.source === "folder");
  assert.deepEqual(textItems.map(item => item.path).sort(), [
    "demo/README.md",
    "demo/src/app.js",
    "demo/src/styles.css"
  ]);
  const imageItems = result.items.filter(item => item.kind === "image");
  assert.equal(imageItems.length, 1);
  assert.equal(imageItems[0].path, "demo/assets/logo.png");
  assert.equal(imageItems[0].mimeType, "image/png");
  assert.match(imageItems[0].dataUrl, /^data:image\/png;base64,/);

  assert.equal(result.summary.included, 4);
  assert.equal(result.summary.includedFiles, 3);
  assert.equal(result.summary.includedImages, 1);
  assert.ok(result.summary.skipped.some(entry => entry.path === "manual.pdf"));
  assert.deepEqual(result.summary.excluded, folder.excluded);
});

test("preparation stops before any read when cancelled", async () => {
  const folder = folderAttachmentFromReport(report());
  const controller = new AbortController();
  controller.abort();
  let reads = 0;
  await assert.rejects(
    () =>
      prepareFolderAttachment(folder, {
        signal: controller.signal,
        readFiles: async () => {
          reads += 1;
          return [];
        }
      }),
    error => error.name === "AbortError"
  );
  assert.equal(reads, 0);
});

test("a late cancellation stops before the next batch", async () => {
  const folder = folderAttachmentFromReport(report());
  const controller = new AbortController();
  let reads = 0;
  await assert.rejects(
    () =>
      prepareFolderAttachment(folder, {
        signal: controller.signal,
        readFiles: async () => {
          reads += 1;
          controller.abort();
          return [];
        }
      }),
    error => error.name === "AbortError"
  );
  assert.equal(reads, 1);
});

test("folder images respect the remaining message byte budget", async () => {
  const folder = folderAttachmentFromReport(report());
  const result = await prepareFolderAttachment(folder, {
    imageBudget: { count: 4, bytes: 10 },
    readFiles: async (token, paths) =>
      paths.map(current =>
        current.endsWith(".png")
          ? { kind: "image", path: current, mimeType: "image/png", base64: PNG_BASE64, size: 68 }
          : { kind: "text", path: current, text: `contents of ${current}`, size: 30 }
      )
  });
  assert.equal(result.items.filter(item => item.kind === "image").length, 0);
  assert.ok(
    result.summary.skipped.some(
      entry => entry.path === "assets/logo.png" && /8 MB or less/.test(entry.reason)
    )
  );
});

test("a capped file listing is reported separately from a stopped scan", async () => {
  const listed = folderAttachmentFromReport(
    report({ totalFiles: 5000, listedTruncated: true, limits: { maxFiles: 5000, maxEntries: 2000 } })
  );
  assert.equal(listed.truncated, false);
  assert.equal(listed.listedTruncated, true);
  const result = await prepareFolderAttachment(listed, {
    readFiles: async (token, paths) =>
      paths.map(current => ({ kind: "text", path: current, text: "x", size: 1 }))
  });
  assert.match(result.items[0].text, /Only the first 6 files are listed/);
  assert.doesNotMatch(result.items[0].text, /scan stopped/);

  const stopped = folderAttachmentFromReport(
    report({ totalFiles: 9000, truncated: true, limits: { maxFiles: 5000 } })
  );
  const stoppedResult = await prepareFolderAttachment(stopped, {
    readFiles: async (token, paths) =>
      paths.map(current => ({ kind: "text", path: current, text: "x", size: 1 }))
  });
  assert.match(stoppedResult.items[0].text, /scan stopped after 5,000 files/);
});

test("composer folder bridge commands are registered and narrowly scoped", () => {
  const main = read("src-tauri/src/main.rs");
  assert.match(main, /mod composer_files;/);
  assert.match(main, /composer_files::ComposerFileState/);
  assert.match(main, /composer_files::composer_pick_folder/);
  assert.match(main, /composer_files::composer_read_files/);

  const permission = read("src-tauri/permissions/composer-files.toml");
  assert.match(permission, /allow-composer-files/);
  assert.match(permission, /composer_pick_folder/);
  assert.match(permission, /composer_read_files/);

  const capability = JSON.parse(read("src-tauri/capabilities/default.json"));
  assert.ok(capability.permissions.includes("allow-composer-files"));

  const bridge = read("src/desktop/composerFiles.js");
  assert.match(bridge, /invoke\("composer_pick_folder"\)/);
  assert.match(bridge, /invoke\("composer_read_files"/);
  assert.match(bridge, /isTauriRuntime/);
});
