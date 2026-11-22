/**
 * The five recommendation lanes.
 *
 * A recommendation is built from a model's own capability flags and from what
 * the detected machine can actually run. A model that does not fit is never
 * recommended, and a category with no compatible model says so instead of
 * borrowing one from another category.
 */

import { classifyModelFit } from "./localHardware.js";

export const RECOMMENDATION_CATEGORIES = Object.freeze([
  Object.freeze({ id: "coding", label: "Coding", capability: "coding", hint: "Code generation and refactoring" }),
  Object.freeze({ id: "chat", label: "Chat", capability: "chat", hint: "Everyday conversation and drafting" }),
  Object.freeze({ id: "vision", label: "Vision", capability: "vision", hint: "Images, screenshots and diagrams" }),
  Object.freeze({ id: "thinking", label: "Thinking", capability: "thinking", hint: "Shows its thinking before answering" }),
  Object.freeze({ id: "reasoning", label: "Reasoning", capability: "reasoning", hint: "Multi-step analysis and maths" })
]);

function storageAllows(row, hardware) {
  const free = Number(hardware?.storageFreeBytes) || 0;
  const download = Number(row?.downloadBytes) || 0;
  if (!free || !download) return true;
  return download < free * 0.95;
}

function usable(row, hardware) {
  const fit = classifyModelFit(row, hardware);
  return {
    row,
    fit,
    usable: fit.level !== "insufficient" && storageAllows(row, hardware)
  };
}

/**
 * Ranks the candidates that fit, largest first. The biggest model that fits is
 * the quality pick; the smallest is offered as the fast pick. Ties prefer a
 * model that is already installed so a recommendation can be used immediately.
 */
function rank(candidates) {
  return [...candidates].sort((a, b) => {
    const aGpu = a.fit.level === "gpu" ? 1 : 0;
    const bGpu = b.fit.level === "gpu" ? 1 : 0;
    if (aGpu !== bGpu) return bGpu - aGpu;
    const aWeight = a.row.installedBytes || a.row.downloadBytes || a.row.params * 0.65e9;
    const bWeight = b.row.installedBytes || b.row.downloadBytes || b.row.params * 0.65e9;
    if (aWeight !== bWeight) return bWeight - aWeight;
    return Number(b.row.installed) - Number(a.row.installed);
  });
}

function describe(row, fit) {
  const capability = row.installed ? "reported by the local runtime" : "from the verified catalogue";
  return `${fit.detail} Capability ${capability}.`;
}

/**
 * Pick up to two models per category: the strongest that fits and, when
 * different, a smaller fast option. Everything returned is executable on this
 * machine and fits in free storage.
 */
export function recommendModels(rows, hardware) {
  const evaluated = (rows || []).map(row => usable(row, hardware));
  return RECOMMENDATION_CATEGORIES.map(category => {
    const compatible = evaluated.filter(candidate =>
      candidate.usable && Array.isArray(candidate.row.capabilities) && candidate.row.capabilities.includes(category.capability)
    );
    const ordered = rank(compatible);
    const picks = [];
    if (ordered.length > 0) picks.push({ ...ordered[0], role: "Recommended" });
    if (ordered.length > 1) {
      const smallest = [...ordered].sort((a, b) => {
        const aWeight = a.row.installedBytes || a.row.downloadBytes || a.row.params * 0.65e9;
        const bWeight = b.row.installedBytes || b.row.downloadBytes || b.row.params * 0.65e9;
        return aWeight - bWeight;
      })[0];
      if (smallest.row.name !== ordered[0].row.name) picks.push({ ...smallest, role: "Fast pick" });
    }
    return {
      ...category,
      picks: picks.map(pick => ({ ...pick, reason: describe(pick.row, pick.fit) })),
      empty: picks.length === 0
        ? `No compatible ${category.label.toLowerCase()} model was found for this device.`
        : ""
    };
  });
}

/** The capability words shown on a catalogue row. */
export function capabilityLabels(row) {
  const labels = [];
  const capabilities = Array.isArray(row?.capabilities) ? row.capabilities : [];
  if (capabilities.includes("coding")) labels.push("Code");
  if (capabilities.includes("vision")) labels.push("Vision");
  if (capabilities.includes("thinking")) labels.push("Thinking");
  if (capabilities.includes("reasoning")) labels.push("Reasoning");
  if (labels.length === 0) labels.push("Chat");
  return labels;
}
