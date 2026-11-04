const MAX_BLOCKS = 6;
export const FACE_MAX_CHARS = 12;

// Slots are authored, not random: the 3D scene and the DOM connector read the
// same anchors, so the handoff line points at the block it actually animated.
export const BLOCK_SLOTS = [
  { x: 0.16, y: 0.66, scale: 1.0, rotY: -0.12, rotZ: 0.03, z: 0.18 },
  { x: 0.44, y: 0.44, scale: 0.82, rotY: 0.14, rotZ: -0.02, z: -0.26 },
  { x: 0.7, y: 0.62, scale: 0.94, rotY: -0.2, rotZ: 0.01, z: 0.02 },
  { x: 0.28, y: 0.24, scale: 0.66, rotY: 0.09, rotZ: 0.04, z: -0.5 },
  { x: 0.58, y: 0.2, scale: 0.58, rotY: -0.07, rotZ: -0.03, z: -0.62 },
  { x: 0.84, y: 0.3, scale: 0.7, rotY: 0.18, rotZ: 0.02, z: -0.4 }
];

// The plate is small and the catalog names are long, so the face carries a short
// display name while the real model id stays intact everywhere else.
//
// Truncation always leaves a visible mark. Without it "Claude Sonnet 4" engraved
// as "Claude" reads as a different model on the block, which is the one thing the
// scene may not do. (P5/C10 replaces this budget with a 10-character cap plus the
// auto-fit and the full-id hover tooltip that make a shorter label safe.)
export function faceLabel(name) {
  const text = String(name || "").trim();
  if (text.length <= FACE_MAX_CHARS) return text;
  const words = text.split(/\s+/).filter(Boolean);
  let kept = "";
  for (const word of words) {
    const next = kept ? `${kept} ${word}` : word;
    if (next.length > FACE_MAX_CHARS) break;
    kept = next;
  }
  /* A single word longer than the plate (or a hyphenated id) has no boundary to
     break at, so it is cut — minus whatever punctuation the cut lands on. */
  const head = kept || text.slice(0, FACE_MAX_CHARS).replace(/[-_/.\s]+$/, "");
  return `${head}…`;
}

function stripNoise(value) {
  return String(value || "")
    .replace(/\s*\((?:free|paid)\)\s*$/i, "")
    .replace(/^[\w .+-]+:\s*/, "")
    .replace(/\s+/g, " ")
    .trim();
}

// "NVIDIA: Nemotron 3.5 Lightning (free)" reads as "Nemotron 3.5" on the plate
// and as the full id in the hover label. A leading word that only repeats the
// provider adds no identity, so it goes before the cap is applied.
export function displayName(row) {
  const raw = text(row?.name) || text(row?.model);
  if (!raw) return "";
  let base = stripNoise(raw) || raw;
  const brands = [text(row?.provider), text(row?.ownedBy)].filter(Boolean).map(v => v.toLowerCase());
  const parts = base.split(" ");
  if (parts.length > 1 && brands.includes(parts[0].toLowerCase())) {
    base = parts.slice(1).join(" ");
  }
  return faceLabel(base);
}

function text(value) {
  return String(value ?? "").trim();
}

// Rows the shell already builds. Anything that cannot answer a request is not a
// candidate block: disabled rows, section headers, gateway status rows, and
// Apex itself, which is an orchestrator rather than a model.
function isBlockRow(row) {
  if (!row || typeof row !== "object") return false;
  if (row.disabled === true) return false;
  if (row.combo === true) return false;
  const kind = text(row.kind);
  if (kind === "group" || kind === "gateway-status" || kind === "gateway") return false;
  return Boolean(text(row.model));
}

export function blocksFromCatalog(rows, { limit = MAX_BLOCKS } = {}) {
  const source = Array.isArray(rows) ? rows : [];
  const cap = Math.max(1, Math.min(MAX_BLOCKS, Number(limit) || MAX_BLOCKS));
  const seen = new Set();
  const blocks = [];
  for (const row of source) {
    if (!isBlockRow(row)) continue;
    const key = text(row.key) || `model:${text(row.model)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const name = text(row.name) || text(row.model);
    const display = displayName(row);
    blocks.push({
      key,
      name,
      display,
      face: display,
      model: text(row.model),
      provider: text(row.provider || row.ownedBy),
      tag: text(row.tag),
      meta: text(row.meta),
      capabilities: Array.isArray(row.capabilityLabels) ? row.capabilityLabels.filter(Boolean) : [],
      active: false,
      slot: BLOCK_SLOTS[blocks.length % BLOCK_SLOTS.length],
      row
    });
    if (blocks.length >= cap) break;
  }
  return blocks;
}

export function markActiveBlock(blocks, activeKey) {
  const key = text(activeKey);
  return blocks.map(block => (key && block.key === key ? { ...block, active: true } : block));
}

// The block the send actually routed to. Returns null when the routed model is
// not one of the blocks on screen, so nothing animates on a guess.
export function handoffBlockFor(blocks, selection) {
  const key = text(selection?.key);
  const model = text(selection?.model);
  if (!key && !model) return null;
  return blocks.find(block => (key && block.key === key) || (model && block.model === model)) || null;
}

export function blockAnchor(block) {
  const slot = block?.slot || BLOCK_SLOTS[0];
  return { x: slot.x, y: slot.y, scale: slot.scale };
}
