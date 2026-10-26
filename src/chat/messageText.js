export const MESSAGE_WORD_LIMIT = 70;

const WORD_PATTERN = /\S+/g;

export function countWords(text) {
  if (typeof text !== "string" || !text) return 0;
  return text.match(WORD_PATTERN)?.length || 0;
}

/**
 * Display-only collapse. The returned `text` is always the untouched original;
 * `display` is what the bubble renders. Whitespace inside the visible prefix is
 * preserved so line breaks the user typed do not disappear when expanded.
 */
export function collapseMessageText(text, limit = MESSAGE_WORD_LIMIT) {
  const original = typeof text === "string" ? text : String(text ?? "");
  const totalWords = countWords(original);
  const max = Number.isInteger(limit) && limit > 0 ? limit : MESSAGE_WORD_LIMIT;
  if (totalWords <= max) {
    return { text: original, display: original, totalWords, truncated: false };
  }

  const pattern = new RegExp(WORD_PATTERN.source, "g");
  let seen = 0;
  let end = 0;
  let match = pattern.exec(original);
  while (match && seen < max) {
    seen += 1;
    end = match.index + match[0].length;
    match = pattern.exec(original);
  }

  const visible = original.slice(0, end).replace(/\s+$/, "");
  return { text: original, display: `${visible}\u2026`, totalWords, truncated: true };
}
