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
  if (files.length >= 2) return files.some(file => file.explicit) || chars >= 1200;
  const [file] = files;
  if (chars >= 3000) return true;
  if (file.explicit && chars >= 600) return true;
  if (/(?:<!doctype html|<html[\s>])/i.test(file.content) && chars >= 900) return true;
  const lines = file.content.split("\n").length;
  return lines >= 50 && chars >= 1200;
}

const CODE_ACTION_RE = /\b(build|create|make|generate|write|code|develop|implement|design|fix|debug|refactor|continue|update|rewrite|add|convert|recreate|clone|optimi[sz]e)\b/i;
const CODE_NOUN_RE = /\b(website|web ?page|site|landing|page|app|application|dashboard|portfolio|project|files?|code|source|html|css|javascript|typescript|js|ts|react|component|program|script|function|game|ui|form|api|layout)\b/i;
const WEBSITE_RE = /\b(website|web ?page|site|landing|homepage)\b/i;
const PROJECT_RE = /\b(app|application|dashboard|project|game|clone)\b/i;

/** Classifies the user's ask without treating every technical question as coding. */
export function codingIntent(prompt) {
  const text = String(prompt || "");
  if (!CODE_ACTION_RE.test(text) || !CODE_NOUN_RE.test(text)) return "";
  if (WEBSITE_RE.test(text)) return "website";
  if (PROJECT_RE.test(text)) return "project";
  return "code";
}

/** A direct ask to see the source in the reply itself keeps the answer inline. */
export function wantsInlineCode(prompt) {
  const text = String(prompt || "").toLowerCase();
  return /\b(show|display|print|paste|give|include|write)\b[^\n.]{0,40}\b(full|entire|whole)?\s*(code|source)\b[^\n.]{0,24}\b(here|inline|in chat|in the chat|in your reply|in the reply|below)\b/.test(text);
}

export function projectTitle(files) {
  const paths = (Array.isArray(files) ? files : []).map(file => String(file?.path || "")).filter(Boolean);
  if (paths.length === 0) return "Generated code";
  if (paths.length === 1) return paths[0];
  const roots = paths.map(path => (path.includes("/") ? path.split("/")[0] : ""));
  if (roots.every(Boolean) && roots.every(root => root === roots[0])) return roots[0];
  if (paths.some(path => /^index\.html?$/i.test(path))) return "Website";
  const html = paths.find(path => /\.html?$/i.test(path));
  if (html) return html.replace(/\.html?$/i, "");
  return "Generated project";
}

/**
 * The artifact a finished turn must keep. A structured backend artifact wins;
 * otherwise the final text is parsed so controls never depend on the cleared
 * streaming buffer.
 */
export function artifactForTurn({ artifact = null, content = "", status = "complete" } = {}) {
  const files = Array.isArray(artifact?.files)
    ? artifact.files.filter(file => file && typeof file.content === "string")
    : [];
  if (files.length > 0) {
    return {
      ...artifact,
      files,
      status: artifact.status || status,
      summary: artifact.summary || responseSummary(content, files)
    };
  }
  return artifactFromResponse(content, { status });
}

/** Merges a continuation tail into the artifact it belongs to. */
export function continueArtifact(artifact, addition, targetPath = "", { status = "complete" } = {}) {
  const files = Array.isArray(artifact?.files) ? artifact.files : [];
  const text = String(addition || "");
  if (!text.trim()) return artifact;
  if (files.length === 0) return artifactFromResponse(text, { status });
  let index = targetPath ? files.findIndex(file => file.path === targetPath) : -1;
  if (index < 0) index = files.findIndex(file => file.complete === false);
  if (index < 0) index = files.length - 1;
  const target = files[index];
  const merged = mergeContinuation(target.content, text, target.path);
  const next = files.map((file, fileIndex) =>
    fileIndex === index
      ? {
          ...file,
          content: merged,
          bytes: new TextEncoder().encode(merged).length,
          complete: status === "complete" ? true : file.complete
        }
      : file
  );
  return {
    ...artifact,
    files: next,
    status,
    summary: artifact.summary || responseSummary("", next)
  };
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
    summary = `${summary.slice(0, ARTIFACT_LIMITS.maxSummaryChars).replace(/\s+\S*$/, "")}…`;
  }
  if (summary) return summary;
  if (!files?.length) return "";
  const names = files.map(file => file.path);
  if (names.length === 1) return `Generated ${names[0]}.`;
  const shown = names.slice(0, 6).join(", ");
  const rest = names.length > 6 ? ` and ${names.length - 6} more` : "";
  return `Generated ${names.length} files: ${shown}${rest}.`;
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

/** Appends a prose continuation without duplicating an overlapping seam. */
export function mergeTextContinuation(base, addition) {
  const original = String(base || "");
  const next = String(addition || "").replace(/\r\n?/g, "\n");
  if (!next.trim()) return original;
  if (!original) return next;
  if (next === original || next.startsWith(original)) return next;
  if (original.endsWith(next)) return original;
  const maxOverlap = Math.min(4000, original.length, next.length);
  for (let size = maxOverlap; size >= 20; size -= 1) {
    if (original.slice(-size) === next.slice(0, size)) return `${original}${next.slice(size)}`;
  }
  return `${original}${next}`;
}

