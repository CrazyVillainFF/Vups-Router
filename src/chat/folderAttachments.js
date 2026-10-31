import {
  ATTACHMENT_LIMITS,
  generateAttachmentId,
  isSensitiveFileName,
  readImageAttachmentFromBase64
} from "./attachments.js";

// Text files have no folder-level count or character cap: every readable text
// file is included. Images follow the message-wide limit. The per-file read
// ceiling keeps one 2 GB log from stalling the composer; anything above it is
// reported with its size instead of vanishing.
export const FOLDER_CONTENT_LIMITS = Object.freeze({
  textFiles: Number.POSITIVE_INFINITY,
  textFileBytes: 2 * 1024 * 1024,
  textTotalBytes: Number.POSITIVE_INFINITY,
  textChars: Number.POSITIVE_INFINITY,
  images: ATTACHMENT_LIMITS.images,
  imageSourceBytes: 20 * 1024 * 1024,
  treeEntries: 400
});

export const FOLDER_SCAN_DEFAULTS = Object.freeze({
  maxFiles: 5000,
  maxDepth: 10,
  maxTreeEntries: 2000
});

function basename(value) {
  const parts = String(value || "").replace(/\\/g, "/").split("/").filter(Boolean);
  return parts.pop() || String(value || "file");
}

function dirname(value) {
  const parts = String(value || "").replace(/\\/g, "/").split("/").filter(Boolean);
  parts.pop();
  return parts.join("/");
}

export function folderScopeName(path) {
  return basename(path) || "Folder";
}

function sortedEntries(entries) {
  return [...(Array.isArray(entries) ? entries : [])].sort((a, b) =>
    String(a?.path || "").localeCompare(String(b?.path || ""), undefined, { numeric: true })
  );
}

/**
 * Builds an indented tree string with branch glyphs. Directories are derived
 * from the file paths, so nested structure survives even though the bridge
 * sends a flat list.
 */
export function buildFolderTree(entries, rootName, maxEntries = FOLDER_CONTENT_LIMITS.treeEntries) {
  const list = sortedEntries(entries).filter(entry => entry && entry.path);
  const total = list.length;
  const shown = list.slice(0, Math.max(0, maxEntries));
  const nodes = new Map();
  const roots = [];

  const child = (parentPath, name) => {
    const key = parentPath ? `${parentPath}/${name}` : name;
    let node = nodes.get(key);
    if (!node) {
      node = { name, path: key, children: new Map(), file: false };
      nodes.set(key, node);
      if (parentPath) {
        const parent = nodes.get(parentPath);
        parent?.children.set(name, node);
      } else {
        roots.push(node);
      }
    }
    return node;
  };

  for (const entry of shown) {
    const parts = String(entry.path).replace(/\\/g, "/").split("/").filter(Boolean);
    let parentPath = "";
    for (let index = 0; index < parts.length; index += 1) {
      const isFile = index === parts.length - 1;
      const name = parts[index];
      const node = child(parentPath, name);
      if (isFile) node.file = true;
      parentPath = parentPath ? `${parentPath}/${name}` : name;
    }
  }

  const lines = [`${rootName}/`];
  const walk = (node, prefix) => {
    const children = [...node.children.values()].sort((a, b) => {
      if (a.file !== b.file) return a.file ? 1 : -1;
      return a.name.localeCompare(b.name, undefined, { numeric: true });
    });
    children.forEach((entry, index) => {
      const last = index === children.length - 1;
      lines.push(`${prefix}${last ? "└── " : "├── "}${entry.name}${entry.file ? "" : "/"}`);
      if (!entry.file) walk(entry, `${prefix}${last ? "    " : "│   "}`);
    });
  };
  const sortedRoots = roots.sort((a, b) => {
    if (a.file !== b.file) return a.file ? 1 : -1;
    return a.name.localeCompare(b.name, undefined, { numeric: true });
  });
  sortedRoots.forEach((root, index) => {
    const last = index === sortedRoots.length - 1;
    lines.push(`${last ? "└── " : "├── "}${root.name}${root.file ? "" : "/"}`);
    if (!root.file) walk(root, last ? "    " : "│   ");
  });
  if (total > shown.length) {
    const rest = total - shown.length;
    lines.push(`… and ${rest.toLocaleString()} more ${rest === 1 ? "entry" : "entries"}`);
  }
  return {
    text: lines.join("\n"),
    shown: shown.length,
    total,
    truncated: total > shown.length
  };
}

function entryKind(entry) {
  const kind = String(entry?.kind || "").toLowerCase();
  if (kind === "text" || kind === "image" || kind === "secret") return kind;
  return "other";
}

export function folderScanOptions(folder) {
  return {
    includeSecrets: Boolean(folder?.options?.includeSecrets),
    includeGenerated: Boolean(folder?.options?.includeGenerated)
  };
}

/**
 * Separates directories from files in the native exclusion list so the
 * composer never reports "skipped files" for folders it did not descend into.
 */
export function folderExclusionStats(folder) {
  const list = Array.isArray(folder?.excluded) ? folder.excluded : [];
  const directories = [];
  const secretFiles = [];
  const otherFiles = [];
  for (const entry of list) {
    const path = String(entry?.path || "");
    if (entry?.kind === "directory" || (!entry?.kind && path.endsWith("/"))) {
      directories.push(entry);
    } else if (entry?.kind === "secret") {
      secretFiles.push(entry);
    } else {
      otherFiles.push(entry);
    }
  }
  return { directories, secretFiles, otherFiles, total: list.length };
}

/**
 * Decides which files can actually be read, without touching file contents.
 * Every exclusion carries a reason that is shown in the composer.
 */
export function planFolderSelection(folder, limits = FOLDER_CONTENT_LIMITS) {
  const entries = sortedEntries(folder?.entries);
  const options = folderScanOptions(folder);
  const text = [];
  const images = [];
  const skipped = [];
  let textBytes = 0;
  let imageBytes = 0;

  for (const entry of entries) {
    const kind = entryKind(entry);
    const size = Number(entry.size) || 0;
    if (!options.includeSecrets && (isSensitiveFileName(basename(entry.path)) || kind === "secret")) {
      skipped.push({
        path: entry.path,
        reason: "Secret file — turn on \"Include secret files\" for this folder to add it."
      });
      continue;
    }
    if (kind === "other") {
      skipped.push({ path: entry.path, reason: "Unsupported file type." });
      continue;
    }
    if (kind === "text" || kind === "secret") {
      if (text.length >= limits.textFiles) {
        skipped.push({ path: entry.path, reason: `Folder limit: ${limits.textFiles} text files are included per message.` });
        continue;
      }
      if (size > limits.textFileBytes) {
        skipped.push({ path: entry.path, reason: `File is larger than ${Math.round(limits.textFileBytes / 1024)} KB.` });
        continue;
      }
      if (textBytes + size > limits.textTotalBytes) {
        skipped.push({ path: entry.path, reason: "Folder size limit for included text reached." });
        continue;
      }
      text.push(entry.path);
      textBytes += size;
      continue;
    }
    if (images.length >= limits.images) {
      skipped.push({ path: entry.path, reason: `Folder limit: ${limits.images} images are attached per message.` });
      continue;
    }
    if (size > limits.imageSourceBytes) {
      skipped.push({ path: entry.path, reason: "Image is larger than the folder attachment limit." });
      continue;
    }
    images.push(entry.path);
    imageBytes += size;
  }

  return {
    text,
    images,
    skipped,
    textBytes,
    imageBytes,
    total: entries.length
  };
}

/**
 * Normalizes the native folder report into the single attachment card the
 * composer shows. It contains metadata only; contents are read on send.
 */
export function folderAttachmentFromReport(report, { limits = FOLDER_CONTENT_LIMITS, previous = null } = {}) {
  if (!report || !report.path) return null;
  const name = report.name || folderScopeName(report.path);
  const entries = Array.isArray(report.entries) ? report.entries : [];
  const excluded = Array.isArray(report.excluded) ? report.excluded : [];
  const options = {
    includeSecrets: Boolean(report.options?.includeSecrets ?? previous?.options?.includeSecrets),
    includeGenerated: Boolean(report.options?.includeGenerated ?? previous?.options?.includeGenerated)
  };
  const tree = buildFolderTree(entries, name, limits.treeEntries);
  const scanLimit = report.limits?.maxFiles || report.scanLimit || FOLDER_SCAN_DEFAULTS.maxFiles;
  const folder = {
    id: previous?.id || generateAttachmentId(),
    kind: "folder",
    name,
    path: report.path,
    token: report.token || previous?.token || "",
    source: "folder",
    status: "ready",
    fileCount: Number(report.totalFiles) || entries.length,
    supportedFiles:
      Number(report.supportedFiles) ||
      entries.filter(entry => {
        const kind = entryKind(entry);
        return kind !== "other" && (options.includeSecrets || kind !== "secret");
      }).length,
    totalBytes: Number(report.totalBytes) || entries.reduce((total, entry) => total + (Number(entry.size) || 0), 0),
    entries,
    excluded,
    options,
    unreadable: Number(report.unreadable) || 0,
    truncated: Boolean(report.truncated),
    listedTruncated: Boolean(report.listedTruncated),
    scanLimit,
    tree: tree.text,
    treeTruncated: tree.truncated,
    treeShown: tree.shown,
    limits: { ...FOLDER_CONTENT_LIMITS, ...(limits || {}) }
  };
  folder.readPlan = planFolderSelection(folder, folder.limits);
  return folder;
}

export function folderTreeLine(folder) {
  if (!folder) return "";
  return folder.treeTruncated
    ? `${folder.tree}\n(tree shows ${folder.treeShown.toLocaleString()} of ${folder.fileCount.toLocaleString()} files)`
    : folder.tree;
}

function folderContextText(folder, { includedFiles, includedImages, skipped, charBudget }) {
  const excluded = folder.excluded || [];
  const visibleExcluded = excluded.slice(0, 12);
  const lines = [
    `Folder: ${folder.name}`,
    `The user selected this local folder in the composer. Only the files listed below were read; nothing else in the folder was accessed.`,
    "",
    `Folder tree:`,
    folderTreeLine(folder),
    "",
    `Disk summary: ${folder.fileCount.toLocaleString()} files, ${(folder.totalBytes / 1024 / 1024).toFixed(1)} MB.`,
    `Included in this message: ${includedFiles} text file${includedFiles === 1 ? "" : "s"} and ${includedImages} image${includedImages === 1 ? "" : "s"}.`
  ];
  if (folderScanOptions(folder).includeSecrets) {
    lines.push("The user explicitly chose to include secret files from this folder; treat their contents as sensitive.");
  }
  if (visibleExcluded.length > 0) {
    lines.push(
      "",
      `Excluded without reading (${excluded.length}):`,
      ...visibleExcluded.map(item => {
        const reason = String(item.reason || "").trim();
        return `- ${item.path}${reason ? ` — ${reason}` : ""}`;
      })
    );
    if (excluded.length > visibleExcluded.length) {
      lines.push(`- … and ${(excluded.length - visibleExcluded.length).toLocaleString()} more excluded entries`);
    }
  }
  if (skipped.length > 0) {
    lines.push(
      "",
      `Skipped files (${skipped.length}):`,
      ...skipped.slice(0, 20).map(item => `- ${item.path} — ${item.reason}`)
    );
    if (skipped.length > 20) lines.push(`- … and ${(skipped.length - 20).toLocaleString()} more skipped files`);
  }
  if (folder.unreadable > 0) {
    lines.push("", `${folder.unreadable} files could not be read because the operating system denied access.`);
  }
  if (folder.truncated) {
    lines.push(
      "",
      `The folder scan stopped after ${folder.scanLimit.toLocaleString()} files. Narrow the selection to include the rest.`
    );
  } else if (folder.listedTruncated) {
    lines.push(
      "",
      `Only the first ${folder.entries.length.toLocaleString()} files are listed and eligible for this message; the folder contains more.`
    );
  }
  lines.push(
    "",
    Number.isFinite(folder.limits.textChars)
      ? `Content limit: at most ${folder.limits.textChars.toLocaleString()} characters of file text are included; the rest is reported as skipped.`
      : "All readable text files in the folder are included; the message size guard is the only remaining limit."
  );
  const text = lines.join("\n");
  return text.length > charBudget ? `${text.slice(0, Math.max(0, charBudget - 24))}\n… context truncated` : text;
}

function abortError() {
  const error = new Error("Folder reading was cancelled.");
  error.name = "AbortError";
  return error;
}

function throwIfAborted(signal) {
  if (signal?.aborted) throw abortError();
}

/**
 * Reads the planned files through the native bridge in small batches. Text is
 * added until the character budget is full; every file left out gets a reason.
 */
export async function prepareFolderAttachment(folder, { readFiles, onProgress, signal, imageBudget } = {}) {
  if (!folder || folder.kind !== "folder") throw new Error("That folder attachment is not valid.");
  if (typeof readFiles !== "function") throw new Error("The folder contents cannot be read in this build.");
  const plan = folder.readPlan || planFolderSelection(folder, folder.limits);
  const imageLimit = Math.min(plan.images.length, Math.max(0, Number(imageBudget?.count ?? folder.limits.images)));
  const imagePaths = plan.images.slice(0, imageLimit);
  const skipped = [...plan.skipped];
  for (const path of plan.images.slice(imageLimit)) {
    skipped.push({ path, reason: imageBudget?.count === 0 ? "Image limit already used by other attachments." : "Image count limit reached for this message." });
  }

  const paths = [...plan.text, ...imagePaths];
  const total = paths.length;
  const results = [];
  // The native bridge accepts up to 50 paths per call; 16 keeps each reply well
  // under the 64 MB payload guard while cutting the round-trip count fourfold.
  const batchSize = 16;
  for (let index = 0; index < paths.length; index += batchSize) {
    throwIfAborted(signal);
    const batch = paths.slice(index, index + batchSize);
    const batchResults = await readFiles(folder.token, batch);
    results.push(...(Array.isArray(batchResults) ? batchResults : []));
    onProgress?.({
      processed: Math.min(total, results.length),
      total,
      phase: results.length < total ? "reading" : "preparing"
    });
  }
  throwIfAborted(signal);

  const textResults = results.filter(result => result?.kind === "text" && typeof result.text === "string");
  const imageResults = results.filter(result => result?.kind === "image" && typeof result.base64 === "string");
  for (const result of results) {
    if (result?.error) skipped.push({ path: result.path, reason: result.error });
  }

  const contextPlaceholder = folderContextText(folder, {
    includedFiles: textResults.length,
    includedImages: imageResults.length,
    skipped,
    charBudget: 6000
  });
  let remainingChars = Math.max(0, folder.limits.textChars - contextPlaceholder.length);

  const items = [];
  let includedFiles = 0;
  for (const result of textResults) {
    const relative = String(result.path || "");
    const text = String(result.text || "");
    if (text.length + 40 > remainingChars) {
      skipped.push({ path: relative, reason: "Folder text limit reached for this message." });
      continue;
    }
    remainingChars -= text.length + 40;
    includedFiles += 1;
    items.push({
      id: generateAttachmentId(),
      kind: "text",
      name: basename(relative),
      path: `${folder.name}/${relative}`,
      mimeType: "text/plain",
      size: Number(result.size) || new TextEncoder().encode(text).length,
      text,
      source: "folder",
      status: "ready"
    });
  }

  const imageItems = [];
  let remainingImageBytes = Math.max(
    0,
    Number.isFinite(Number(imageBudget?.bytes)) ? Number(imageBudget.bytes) : Number.POSITIVE_INFINITY
  );
  for (const result of imageResults) {
    throwIfAborted(signal);
    try {
      const item = await readImageAttachmentFromBase64({
        name: basename(result.path),
        mimeType: result.mimeType,
        base64: result.base64,
        size: result.size
      });
      if (item.size > remainingImageBytes) {
        skipped.push({
          path: result.path,
          reason: "Images for this message must total 8 MB or less; this one did not fit."
        });
        continue;
      }
      remainingImageBytes -= item.size;
      item.path = `${folder.name}/${result.path}`;
      item.source = "folder";
      imageItems.push(item);
    } catch (error) {
      skipped.push({ path: result.path, reason: error?.message || "That image could not be converted." });
    }
  }

  const context = folderContextText(folder, {
    includedFiles,
    includedImages: imageItems.length,
    skipped,
    charBudget: Math.max(1200, folder.limits.textChars - items.reduce((sum, item) => sum + item.text.length + 40, 0))
  });
  const contextItem = {
    id: generateAttachmentId(),
    kind: "text",
    name: `${folder.name} (folder)`,
    path: `${folder.name}/`,
    mimeType: "text/plain",
    size: new TextEncoder().encode(context).length,
    text: context,
    source: "folder-context",
    status: "ready"
  };

  return {
    items: [contextItem, ...items, ...imageItems],
    summary: {
      folder: folder.name,
      selected: folder.fileCount,
      supported: folder.supportedFiles,
      included: includedFiles + imageItems.length,
      includedFiles,
      includedImages: imageItems.length,
      skipped,
      excluded: folder.excluded || [],
      truncated: folder.truncated
    }
  };
}

