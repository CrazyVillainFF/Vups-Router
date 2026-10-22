import JSZip from "jszip";
import { mimeForFile, safeFilePath } from "./codeFiles.js";

export const ZIP_ROOT = "vups-website";

export function projectZipName(date = new Date()) {
  const stamp = Number.isNaN(date.getTime()) ? "" : `-${date.toISOString().slice(0, 10)}`;
  return `${ZIP_ROOT}${stamp}.zip`;
}

export async function buildProjectZip(files, { root = ZIP_ROOT } = {}) {
  if (!Array.isArray(files) || files.length === 0) {
    throw new Error("There are no generated files to package.");
  }
  const zip = new JSZip();
  let added = 0;
  for (const file of files) {
    const path = safeFilePath(file?.path);
    if (!path || typeof file?.content !== "string" || !file.content.trim()) continue;
    const prefix = safeFilePath(root) || ZIP_ROOT;
    zip.file(`${prefix}/${path}`, file.content);
    added += 1;
  }
  if (added === 0) throw new Error("There are no generated files to package.");
  return zip.generateAsync({
    type: "blob",
    compression: "DEFLATE",
    compressionOptions: { level: 6 },
    platform: "UNIX"
  });
}

export function downloadBlob(blob, filename, urls) {
  if (typeof document === "undefined" || typeof URL === "undefined") {
    throw new Error("Downloads are only available in the browser.");
  }
  const url = URL.createObjectURL(blob);
  urls?.add(url);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.rel = "noopener";
  link.style.display = "none";
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => {
    URL.revokeObjectURL(url);
    urls?.delete(url);
  }, 10000);
}

export function downloadGeneratedFile(file, urls) {
  const path = safeFilePath(file?.path);
  if (!path || typeof file?.content !== "string") {
    throw new Error("That generated file is not valid.");
  }
  const name = path.split("/").pop();
  const blob = new Blob([file.content], { type: mimeForFile(path) });
  downloadBlob(blob, name, urls);
}
