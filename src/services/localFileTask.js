// Deterministic intent matching for the filesystem requests that used to cost
// two model round trips and one permission prompt per file. A match names a
// single local operation; it never produces results of its own.

const KNOWN_FOLDERS = Object.freeze({
  downloads: "downloads",
  download: "downloads",
  documents: "documents",
  document: "documents",
  pictures: "pictures",
  photo: "pictures",
  photos: "pictures",
  images: "pictures",
  music: "music",
  videos: "videos",
  video: "videos",
  desktop: "desktop"
});

const WORD_NUMBERS = Object.freeze({
  one: 1, two: 2, three: 3, four: 4, five: 5,
  six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
  fifteen: 15, twenty: 20
});

const RECENCY = /\b(latest|newest|most\s+recent|recent)\b/i;
const PATH_WORD = /\b(path|location|where)\b/i;
const LISTING = /\b(list|show|how\s+many|what\s+are|enumerate)\b/i;
// Anything that has to look inside a file, or that asks for a judgement about
// file contents, is the model's job, not a directory enumeration.
const CONTENT_NEED =
  /\b(?:read|open|summar|transcrib|extract|grep|compare|analyz|analys)\w*\b/i;
const DOWNLOADS_WORD = /\b(downloads?|downloaded)\b/i;

const NAMED_FOLDER_PATTERNS = Object.freeze([
  /\b(?:find|locate|search\s+for)\s+(?:my\s+|the\s+|a\s+|an\s+)?["“']?([A-Za-z0-9][A-Za-z0-9._'’\- ]{0,60}?)["”']?\s+(?:folder|directory)\b/i,
  /\bwhere(?:'s|\s+is)\s+(?:my\s+|the\s+|a\s+|an\s+)?["“']?([A-Za-z0-9][A-Za-z0-9._'’\- ]{0,60}?)["”']?\s+(?:folder|directory)\b/i,
  /\b(?:path\s+(?:to|of)|location\s+of)\s+(?:my\s+|the\s+|a\s+|an\s+)?["“']?([A-Za-z0-9][A-Za-z0-9._'’\- ]{0,60}?)["”']?\s+(?:folder|directory)\b/i,
  /\b(?:folder|directory)\s+(?:called|named)\s+["“']([^"”'\n]{1,60})["”']/i,
  /\b(?:folder|directory)\s+(?:called|named)\s+([^\s"”'\n]{1,60})(?=\s|$|[?!,;])/i
]);

const NAMED_FILE_PATTERN =
  /\b(?:find|locate|look\s+for|where(?:'s|\s+is))\s+(?:a\s+|the\s+|my\s+)?file\s+(?:named|called)\s+["“']?([^"”'\n]{1,80})/i;
const DIRECT_FILE_PATTERN =
  /\b(?:find|locate|where(?:'s|\s+is))\s+(?:my\s+|the\s+|a\s+)?["“']?([A-Za-z0-9][A-Za-z0-9._\- ]{0,60}\.[A-Za-z0-9]{1,12})["”']?(?=\s|[?!,;]|$)/i;

const GENERIC_FOLDER_QUERIES = new Set([
  "folder", "directory", "file", "files", "path", "thing", "things", "stuff",
  "it", "that", "this", "new", "old", "lost", "missing"
]);
const FOLDER_QUERY_STOPWORDS =
  /\b(?:and|or|in|on|at|for|with|from|give|show|tell|me|my|the|a|an|please|can|could|you|is|are|of)\b/i;
// Characters Windows forbids in a file or folder name; a query containing one
// is a path fragment, not a name, and must not be guessed into a search.
const INVALID_NAME_CHARS = /[\\/:*?"<>|]/;

const MAX_FAST_PATH_CHARS = 400;
const MAX_FOLDER_QUERY_CHARS = 60;
const MAX_FILE_QUERY_CHARS = 80;

function normalize(text) {
  return String(text || "").replace(/\s+/g, " ").trim();
}

function cleanQuery(value) {
  return String(value || "")
    .replace(/\s+/g, " ")
    .replace(/^[\s"'“”‘’]+|[\s"'“”‘’]+$/g, "")
    .replace(/[.,!?;:]+$/g, "")
    .trim();
}

function detectFolder(text) {
  // "my downloaded files" and "my downloads folder" are the same request, and
  // neither one tells us a username, so the path still comes from Windows.
  if (DOWNLOADS_WORD.test(text)) return "downloads";
  const match = /\b(documents?|pictures?|photos?|images?|music|videos?|desktop)\b/i.exec(text);
  if (!match) return "";
  return KNOWN_FOLDERS[match[1].toLowerCase()] || "";
}

function detectCount(text, fallback) {
  const digits = /\b(\d{1,2})\b/.exec(text);
  if (digits) {
    const value = Number(digits[1]);
    return value >= 1 && value <= 50 ? value : fallback;
  }
  const words = /\b(one|two|three|four|five|six|seven|eight|nine|ten|fifteen|twenty)\b/i.exec(text);
  return words ? WORD_NUMBERS[words[1].toLowerCase()] : fallback;
}

function validFolderQuery(value) {
  const query = cleanQuery(value);
  if (!query || query.length > MAX_FOLDER_QUERY_CHARS) return "";
  if (query.split(" ").length > 6) return "";
  if (GENERIC_FOLDER_QUERIES.has(query.toLowerCase())) return "";
  // A known folder is resolved by Windows, not searched for by name.
  if (KNOWN_FOLDERS[query.toLowerCase()]) return "";
  if (FOLDER_QUERY_STOPWORDS.test(query)) return "";
  if (INVALID_NAME_CHARS.test(query)) return "";
  return query;
}

function validFileQuery(value) {
  const query = cleanQuery(value);
  if (!query || query.length > MAX_FILE_QUERY_CHARS) return "";
  if (query === "." || query === ".." || query.includes("..")) return "";
  if (INVALID_NAME_CHARS.test(query)) return "";
  return query;
}

function detectFolderQuery(text) {
  for (const pattern of NAMED_FOLDER_PATTERNS) {
    const match = pattern.exec(text);
    if (!match) continue;
    const query = validFolderQuery(match[1]);
    if (query) return query;
  }
  return "";
}

function detectFileQuery(text) {
  const named = NAMED_FILE_PATTERN.exec(text);
  if (named) {
    // A filename can contain spaces, so stop only where the request says the
    // name ends instead of at the first space.
    const raw = named[1].split(/\s+(?:in|inside|under|on|within|and|then|give|show|tell|please)\b/i)[0];
    const query = validFileQuery(raw);
    if (query) return query;
  }
  const direct = DIRECT_FILE_PATTERN.exec(text);
  if (direct) {
    const query = validFileQuery(direct[1]);
    if (query) return query;
  }
  return "";
}

/**
 * Returns `{ kind, ... }` when the request is answerable with local
 * enumeration/search, or `null` when the model genuinely has to decide what to
 * do. `null` keeps the ordinary tool loop, so nothing is lost by being
 * conservative here.
 *
 * Kinds:
 * - `locate`       — resolve a Windows known folder
 * - `recent`       — newest files in a known folder
 * - `list`         — enumerate a known folder
 * - `locate_named` — look for a folder by name under Windows folders/workspaces
 * - `find`         — look for a file by name under Windows folders/workspaces
 */
export function matchLocalFileTask(text) {
  const message = normalize(text);
  if (!message || message.length > MAX_FAST_PATH_CHARS) return null;
  // Anything that asks about a file's contents needs the model, not a listing.
  if (CONTENT_NEED.test(message)) return null;

  const folder = detectFolder(message);
  const fileQuery = detectFileQuery(message);
  if (fileQuery) {
    return {
      kind: "find",
      folder,
      query: fileQuery,
      limit: detectCount(message, 20),
      intent: folder
        ? `Searching your ${folder} folder for ${fileQuery}`
        : `Searching your local folders for ${fileQuery}`
    };
  }

  const folderQuery = detectFolderQuery(message);
  if (folderQuery) {
    return {
      kind: "locate_named",
      folder,
      query: folderQuery,
      intent: `Finding your ${folderQuery} folder`
    };
  }

  if (!folder) return null;

  // "Find my Downloads folder and give me the path" asks where it is, not what
  // is inside it.
  if (PATH_WORD.test(message) && !RECENCY.test(message)) {
    return { kind: "locate", folder, limit: 0, intent: `Resolving your ${folder} folder path` };
  }

  if (RECENCY.test(message)) {
    const limit = detectCount(message, 5);
    return {
      kind: "recent",
      folder,
      limit,
      intent: `Listing the ${limit} most recent files in your ${folder} folder`
    };
  }

  if (LISTING.test(message)) {
    return {
      kind: "list",
      folder,
      limit: detectCount(message, 20),
      intent: `Listing your ${folder} folder`
    };
  }

  return null;
}
