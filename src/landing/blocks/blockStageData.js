import { PROVIDERS } from "../../providers/registry.js";
import { VUPS_MODEL_NAME } from "../../chat/modelCatalog.js";
import { paletteFor } from "../../home/blocksMaterials.js";

// The stage may only engrave names that exist in the shipped catalog. A
// signed-out visitor has no model list — /api/settings/free-models answers 401
// — so the built-in model plus registry entries are the whole honest vocabulary.
// Nothing here carries speed, price or benchmark metadata: the registry has
// none, and inventing it would be a claim about a product feature.

export const ROUTED_BLOCK = VUPS_MODEL_NAME;

export const stageBlocks = [
  { name: VUPS_MODEL_NAME, kind: "Built-in model", routed: true },
  ...PROVIDERS.slice(0, 6).map(provider => ({
    name: provider.name,
    kind: `${provider.category === "aggregator" ? "Aggregator" : provider.category === "local" ? "Local gateway" : provider.category === "custom" ? "Custom endpoint" : "Provider"} route`,
    routed: false
  }))
];

export const marqueeNames = PROVIDERS.map(provider => provider.name);

// The film has one palette, stated by the brief: graphite clay on a warm black
// floor, orange on exactly one block. It reuses the shipped Blocks palette so
// the accent and light hexes cannot drift from the tokens, and overrides only
// the two clay bodies.
export const STAGE_PALETTE = {
  ...paletteFor("dark"),
  clay: "var(--bg)",
  clayAlt: "var(--bg)",
  floor: "var(--bg)"
};
