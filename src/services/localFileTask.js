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
  /\b(?:read|open|summar|transcrib|extract|grep|compare|analyz|analys)\w*\b|\bsearch(?:ing)?\s+for\b|\bfind\s+(?:a\s+)?file\s+named\b/i;
const DOWNLOADS_WORD = /\b(downloads?|downloaded)\b/i;

const MAX_FAST_PATH_CHARS = 400;

function normalize(text) {
  return String(text || "").replace(/\s+/g, " ").trim();
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

/**
 * Returns `{ kind, folder, limit, intent }` when the request is answerable with
 * one local enumeration, or `null` when the model genuinely has to decide what
 * to do. `null` keeps the ordinary tool loop, so nothing is lost by being
 * conservative here.
 */
export function matchLocalFileTask(text) {
  const message = normalize(text);
  if (!message || message.length > MAX_FAST_PATH_CHARS) return null;
  const folder = detectFolder(message);
  if (!folder) return null;
  // Anything that asks about a file's contents needs the model, not a listing.
  if (CONTENT_NEED.test(message)) return null;

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
