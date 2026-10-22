const FENCE_RE = /^[ \t]{0,3}(`{3,}|~{3,})[ \t]*([^\n]*)\n([\s\S]*?)^[ \t]{0,3}\1[ \t]*\r?$/gm;
const FILE_MARKER_RE = /\b(?:file|filename)\s*:\s*[`"'*]*([^\s`"'*]+)/gi;
const PATH_TOKEN_RE = /(?:^|\s)([^\s`"']+\.[a-z0-9]{1,12})(?=\s|$)/i;
const INFO_FILE_RE = /(?:filename|file|title|name)\s*=\s*["']?([^"'\s]+)/i;
const KNOWN_LANGS = new Set([
  "html", "htm", "css", "js", "javascript", "mjs", "cjs", "jsx", "ts", "typescript",
  "tsx", "json", "svg", "xml", "md", "markdown", "py", "python", "java", "kotlin",
  "swift", "c", "cpp", "cs", "go", "rs", "rust", "php", "sql", "yml", "yaml",
  "toml", "ini"
]);
const EXTENSIONS = {
  html: "html", htm: "html", css: "css", js: "js", javascript: "js", mjs: "mjs",
  cjs: "cjs", jsx: "jsx", ts: "ts", typescript: "ts", tsx: "tsx", json: "json",
  svg: "svg", xml: "xml", md: "md", markdown: "md", py: "py", python: "py",
  java: "java", kotlin: "kt", swift: "swift", c: "c", cpp: "cpp", cs: "cs",
  go: "go", rs: "rs", rust: "rs", php: "php", sql: "sql", sh: "sh", bash: "sh",
  yml: "yml", yaml: "yml", toml: "toml", ini: "ini", txt: "txt"
};
const DEFAULT_NAMES = {
  html: "index.html", htm: "index.html", css: "styles.css", js: "script.js",
  javascript: "script.js", mjs: "script.mjs", cjs: "script.cjs", jsx: "App.jsx",
  ts: "script.ts", typescript: "script.ts", tsx: "App.tsx", json: "data.json",
  svg: "image.svg", xml: "document.xml", md: "document.md", markdown: "document.md",
  py: "main.py", python: "main.py", java: "Main.java", kotlin: "Main.kt",
  swift: "main.swift", c: "main.c", cpp: "main.cpp", cs: "Program.cs", go: "main.go",
  rs: "main.rs", rust: "main.rs", php: "index.php", sql: "query.sql", sh: "script.sh",
  bash: "script.sh", yml: "config.yml", yaml: "config.yml", toml: "config.toml",
  ini: "config.ini", txt: "file.txt"
};

function cleanInfo(info) {
  return typeof info === "string" ? info.trim().replace(/^\{\.?|^\s*/, "") : "";
}

function filenameFromInfo(info) {
  const value = cleanInfo(info);
  if (!value) return "";
  const named = INFO_FILE_RE.exec(value)?.[1];
  if (named) return named;
  const languagePath = /^[a-z0-9+#-]+:([^\s]+)$/i.exec(value)?.[1];
  if (languagePath) return languagePath;
  const token = PATH_TOKEN_RE.exec(value)?.[1];
  return token || "";
}

function filenameNear(text) {
  const tail = typeof text === "string" ? text.split("\n").slice(-10).join("\n") : "";
  let match;
  let marker = "";
  FILE_MARKER_RE.lastIndex = 0;
  while ((match = FILE_MARKER_RE.exec(tail))) marker = match[1];
  if (marker) return marker;

  const lines = tail.split("\n").map(line => line.trim()).filter(Boolean).reverse();
  for (const line of lines) {
    const heading = /^#{1,6}\s+[`"']?([^\s`"']+)[`"']?\s*$/.exec(line);
    if (heading) return heading[1];
    const bold = /^(?:\*\*|__)[`"']?([^\s`"']+)[`"']?(?:\*\*|__)\s*:?\s*$/.exec(line);
    if (bold) return bold[1];
    const quoted = /^[`"']([^`"'\s]+\.[a-z0-9]{1,12})[`"']\s*:?\s*$/i.exec(line);
    if (quoted) return quoted[1];
    const plain = /^([a-z0-9_.-]+(?:\/[a-z0-9_.-]+)*\.[a-z0-9]{1,12})\s*:?\s*$/i.exec(line);
    if (plain) return plain[1];
  }
  return "";
}

function trimSegment(segment) {
  return segment
    .replace(/[\u0000-\u001f<>:"|?*]/g, "-")
    .replace(/\s+/g, " ")
    .replace(/[. ]+$/g, "")
    .trim();
}

export function safeFilePath(input, fallback = "") {
  let value = typeof input === "string" ? input.trim().replace(/\\/g, "/") : "";
  if (!value) value = fallback;
  if (!value || /^[a-z][a-z0-9+.-]*:\/\//i.test(value) || value.endsWith("/")) return null;
  value = value.replace(/^[a-zA-Z]:\/?/, "").replace(/^\/+/, "");
  const parts = [];
  for (const raw of value.split("/")) {
    if (!raw || raw === "." || raw === "..") {
      if (raw === "..") return null;
      continue;
    }
    let segment = trimSegment(raw);
    if (!segment) continue;
    if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i.test(segment)) segment = `_${segment}`;
    if (segment.length > 100) {
      const dot = segment.lastIndexOf(".");
      const ext = dot > 0 ? segment.slice(dot) : "";
      segment = `${segment.slice(0, Math.max(1, 100 - ext.length))}${ext}`;
    }
    parts.push(segment);
  }
  if (parts.length === 0) return null;
  const path = parts.join("/");
  return path.length <= 180 ? path : null;
}

function uniquePath(path, used) {
  if (!used.has(path.toLowerCase())) {
    used.add(path.toLowerCase());
    return path;
  }
  const slash = path.lastIndexOf("/");
  const dir = slash >= 0 ? path.slice(0, slash + 1) : "";
  const name = slash >= 0 ? path.slice(slash + 1) : path;
  const dot = name.lastIndexOf(".");
  const base = dot > 0 ? name.slice(0, dot) : name;
  const ext = dot > 0 ? name.slice(dot) : "";
  for (let i = 2; i < 100; i += 1) {
    const candidate = `${dir}${base}-${i}${ext}`;
    if (!used.has(candidate.toLowerCase())) {
      used.add(candidate.toLowerCase());
      return candidate;
    }
  }
  return null;
}

export function extractCodeFiles(markdown) {
  if (typeof markdown !== "string" || !markdown.trim()) return [];
  const files = [];
  const used = new Set();
  let cursor = 0;
  let match;

  FENCE_RE.lastIndex = 0;
  while ((match = FENCE_RE.exec(markdown))) {
    const [full, , rawInfo, rawContent] = match;
    const preceding = markdown.slice(cursor, match.index);
    cursor = match.index + full.length;
    const info = cleanInfo(rawInfo);
    const lang = info.split(/\s+/)[0].toLowerCase().replace(/^language-/, "").replace(/[^\w+-]/g, "");
    const content = rawContent.replace(/\r\n/g, "\n");
    if (!content.trim()) continue;

    const explicit = filenameFromInfo(info) || filenameNear(preceding);
    if (!explicit && !KNOWN_LANGS.has(lang)) continue;
    const fallback = DEFAULT_NAMES[lang] || `code-${files.length + 1}.txt`;
    const path = safeFilePath(explicit, fallback);
    if (!path) continue;
    const unique = uniquePath(path, used);
    if (!unique) continue;
    files.push({
      path: unique,
      content,
      language: lang || EXTENSIONS[path.split(".").pop()?.toLowerCase()] || "",
      bytes: new TextEncoder().encode(content).length
    });
  }

  return files;
}

export function isWebsitePackage(files) {
  return Array.isArray(files) && files.length > 1 && files.some(file => /\.html?$/i.test(file.path));
}

export function mimeForFile(path) {
  const ext = String(path || "").split(".").pop()?.toLowerCase();
  const types = {
    html: "text/html", htm: "text/html", css: "text/css", js: "text/javascript",
    mjs: "text/javascript", cjs: "text/javascript", jsx: "text/javascript",
    ts: "text/typescript", tsx: "text/typescript", json: "application/json",
    svg: "image/svg+xml", xml: "application/xml", md: "text/markdown",
    markdown: "text/markdown", py: "text/x-python", java: "text/x-java-source",
    kt: "text/plain", swift: "text/plain", c: "text/x-c", cpp: "text/x-c++",
    cs: "text/plain", go: "text/plain", rs: "text/plain", php: "text/x-php",
    sql: "application/sql", sh: "text/x-shellscript", yml: "text/yaml",
    yaml: "text/yaml", toml: "text/plain", ini: "text/plain", txt: "text/plain"
  };
  return `${types[ext] || "text/plain"};charset=utf-8`;
}

export function fileSizeLabel(bytes) {
  const value = Number(bytes) || 0;
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  return `${(value / (1024 * 1024)).toFixed(1)} MB`;
}
