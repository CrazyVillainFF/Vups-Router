import { extractCodeFiles, isWebsitePackage } from "./codeFiles.js";

export const ARTIFACT_LIMITS = {
  maxFiles: 40,
  maxFileChars: 500_000,
  maxTotalChars: 1_500_000,
  maxSummaryChars: 8_000
};

export function shouldCreateArtifact(files) {
  if (!Array.isArray(files) || files.length === 0) return false;
  const chars = files.reduce((total, file) => total + file.content.length, 0);
  if (isWebsitePackage(files)) return true;
  if (files.length >= 2 && (files.some(file => file.explicit) || chars >= 1200)) return true;
  return files.length === 1 && chars >= 3000;
}

function stripCodeFences(markdown) {
  const text = String(markdown || "").replace(/\r\n?/g, "\n");
  const lines = text.split("\n");
  const removed = new Set();
  for (let index = 0; index < lines.length; index += 1) {
    const open = /^[ \t]{0,3}(`{3,}|~{3,})[ \t]*([^\n]*?)\r?$/.exec(lines[index]);
    if (!open) continue;
    const marker = open[1];
    let close = -1;
    for (let scan = index + 1; scan < lines.length; scan += 1) {
      const candidate = /^[ \t]{0,3}(`{3,}|~{3,})[ \t]*\r?$/.exec(lines[scan]);
      if (candidate && candidate[1][0] === marker[0] && candidate[1].length >= marker.length) {
        close = scan;
        break;
      }
    }
    removed.add(index);
    const end = close === -1 ? lines.length - 1 : close;
    for (let scan = index; scan <= end; scan += 1) removed.add(scan);
    if (close === -1) break;
    index = close;
  }
  return lines
    .filter((_, index) => !removed.has(index))
    .join("\n")
    .replace(/^[ \t]*FILE:\s*\S+[ \t]*$/gim, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export function responseSummary(markdown, files) {
  let summary = stripCodeFences(markdown);
  if (summary.length > ARTIFACT_LIMITS.maxSummaryChars) {
    summary = `${summary.slice(0, ARTIFACT_LIMITS.maxSummaryChars).replace(/\s+\S*$/, "")}â€¦`;
  }
  if (summary) return summary;
  if (!files?.length) return "";
  if (files.length === 1) return `Generated ${files[0].path}.`;
  return `Generated a project with ${files.length} files.`;
}

export function artifactFromResponse(markdown, { status = "complete" } = {}) {
  const files = extractCodeFiles(markdown, { includeUnclosed: status !== "complete" });
  if (!shouldCreateArtifact(files)) return null;
  return {
    files: files.map((file, index) => ({
      ...file,
      complete: status === "complete" || index < files.length - 1
    })),
    summary: responseSummary(markdown, files),
    status
  };
}

export function streamingArtifact(markdown) {
  const files = extractCodeFiles(markdown, { includeUnclosed: true });
  if (!shouldCreateArtifact(files)) return null;
  return {
    files: files.map((file, index) => ({
      ...file,
      complete: file.complete && index < files.length - 1
    })),
    status: "partial"
  };
}

export function artifactBytes(files) {
  return (Array.isArray(files) ? files : []).reduce(
    (total, file) => total + Number(file?.bytes || new TextEncoder().encode(String(file?.content || "")).length),
    0
  );
}

function cleanAddition(text, targetPath) {
  const parsed = extractCodeFiles(text, { includeUnclosed: true });
  if (parsed.length > 0) {
    const match = parsed.find(file => file.path === targetPath);
    const file = match || parsed[parsed.length - 1];
    const content = file.content.replace(/\r\n?/g, "\n");
    return /\n```\s*$/.test(String(text || "")) ? content.replace(/\n$/, "") : content;
  }
  return String(text || "")
    .replace(/^\s*```[^\n]*\n/, "")
    .replace(/\n```\s*$/, "")
    .replace(/\r\n?/g, "\n")
    .replace(/^\n/, "");
}

export function mergeContinuation(base, addition, targetPath = "") {
  const original = String(base || "");
  let next = cleanAddition(addition, targetPath);
  if (!next) return original;
  if (original && (next.startsWith(original) || (next.includes(original) && original.length > 40))) return next;

  const maxOverlap = Math.min(4000, original.length, next.length);
  for (let size = maxOverlap; size >= 20; size -= 1) {
    if (original.slice(-size) === next.slice(0, size)) {
      next = next.slice(size);
      break;
    }
  }
  if (!next) return original;
  
  return `${original}${next}`;
}
