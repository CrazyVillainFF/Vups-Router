import { PROVIDER_CATEGORIES, PROVIDERS, providersByCategory } from "../../providers/registry.js";
import { MARK_SIZE, orbitSlots } from "./markGeometry.js";

/* The routing diagram is built from the registry the app actually ships.

   `PROVIDERS` is the same list the settings screen renders, every entry carrying
   a real id, name, category and protocol family — so the constellation is a
   visualisation of shipped configuration, not a picture of partnerships. It
   shows nothing that the app does not have: no logos, no request counts, no
   latency, no status lights. The copy beside it has to say exactly that, and the
   bead travelling down a cable is a rendering of the word "routing", not of a
   call that happened. */

/** Categories in the registry's own order, with the entries that belong to each. */
export function constellationGroups() {
  return PROVIDER_CATEGORIES.map(category => ({
    id: category.id,
    label: category.label,
    hint: category.hint || "",
    providers: providersByCategory(category.id)
  }));
}

const RING_START = 24;
const RING_SPAN = 312;
const ARC_GAP = 9;

/** One arc per category, laid end to end around the mark. The ring is tilted by
    the slot maths in `orbitSlots`, so the far side sits higher and further back
    and the cluster reads as an object in a room rather than a flat diagram. */
export function constellationNodes({ limitPerGroup = Infinity } = {}) {
  const groups = constellationGroups();
  const usable = groups.reduce(
    (sum, group) => sum + Math.min(group.providers.length, limitPerGroup),
    0
  );
  const gapTotal = ARC_GAP * groups.length;
  const perEntry = usable > 1 ? (RING_SPAN - gapTotal) / usable : RING_SPAN;

  const nodes = [];
  let cursor = RING_START;

  for (const group of groups) {
    const list = group.providers.slice(0, Math.max(0, limitPerGroup));
    const slots = orbitSlots(list.length, {
      radius: MARK_SIZE * (group.id === "direct" ? 1.72 : 2.05),
      startDeg: cursor,
      endDeg: cursor + perEntry * Math.max(1, list.length - 1),
      y: group.id === "local" ? -0.16 : group.id === "custom" ? 0.16 : 0
    });
    list.forEach((provider, index) => {
      nodes.push({
        id: provider.id,
        name: provider.name,
        categoryId: group.id,
        categoryLabel: group.label,
        compatibility: provider.compatibility,
        status: provider.status,
        deployment: provider.deployment,
        slot: slots[index]
      });
    });
    cursor += perEntry * Math.max(1, list.length - 1) + ARC_GAP;
  }

  return nodes;
}

/** What the DOM has to be able to say about the diagram, counted from the same
    registry the canvas draws — the numbers are never typed by hand. */
export function constellationFacts() {
  const groups = constellationGroups();
  return {
    total: PROVIDERS.length,
    groups: groups.map(group => ({
      id: group.id,
      label: group.label,
      count: group.providers.length,
      sample: group.providers.slice(0, 3).map(provider => provider.name)
    })),
    protocols: [...new Set(PROVIDERS.map(provider => provider.compatibility))]
  };
}

/** The honest sentence the section needs: what is real and what is drawn. */
export function constellationDisclaimer() {
  return `Every name comes from the ${PROVIDERS.length} entries in the provider registry. The diagram shows how a request is routed; it does not show live traffic, latency or availability.`;
}
