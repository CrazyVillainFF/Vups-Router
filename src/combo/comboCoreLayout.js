export const CORE_VIEWBOX = { width: 960, height: 600 };

const DENSITY = {
  comfortable: { max: 8, node: 58, narrowNode: 46, centerScale: 1 },
  compact: { max: 14, node: 50, narrowNode: 40, centerScale: 0.88 },
  dense: { max: Infinity, node: 42, narrowNode: 28, centerScale: 0.74 }
};

const INNER_RING_SCALE = 0.7;

// The core has to stay the dominant element of the composition. Below roughly
// two node widths it stops reading as the center and becomes another disc in
// the harness, which is what the density scaling can drift toward on phones.
const CORE_OVER_NODE = 2.2;

export function coreDensity(count) {
  if (count <= DENSITY.comfortable.max) return "comfortable";
  if (count <= DENSITY.compact.max) return "compact";
  return "dense";
}

export function coreIntensity(working, selected) {
  const total = Math.max(0, Number(selected) || 0);
  const active = Math.max(0, Number(working) || 0);
  if (total === 0 || active === 0) return 0;
  return Math.max(0.18, Math.min(1, active / total));
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function ringPlan(count, { rx, ry, centerRadius, nodeRadius }) {
  if (count <= 12) return [{ count, scale: 1, offset: 0 }];
  const outer = Math.ceil(count * 0.6);
  const inner = count - outer;
  const clearance = Math.min(rx, ry) * INNER_RING_SCALE - centerRadius - nodeRadius;
  if (inner > 0 && clearance >= 12) {
    return [
      { count: outer, scale: 1, offset: 0 },
      { count: inner, scale: INNER_RING_SCALE, offset: Math.PI / Math.max(1, inner) }
    ];
  }
  return [{ count, scale: 1, offset: 0 }];
}

// A cable tip has to disappear *under* a housing to read as plugged in, but it
// can never reach the artwork painted on that housing. The central logo occupies
// 46% of the core width (radius * 0.46) and a provider mark 60% of the node
// width including its corner diagonals (radius * 0.79), so each housing keeps a
// reserved outer band for the cable to land in. Stopping outside the rim instead
// - which an earlier version of this file did - leaves a bare gap at both ends
// of every cable, which is what made the harness look disconnected.
const TUCK_PX = 5;
const TUCK_MAX_FRACTION = 0.15;
const ARTWORK_BAND = { core: 0.62, node: 0.8 };

function tuckDepth(radius, bandFloor) {
  if (!(radius > 0)) return 0;
  return Math.min(TUCK_PX, radius * TUCK_MAX_FRACTION, radius * (1 - bandFloor));
}

export function wireAnchorRadii(centerRadius, nodeRadius, distance) {
  // 0.92 of the core radius is inside the painted housing cap (radiusTop is 0.94
  // of centerRadius), so the tip is always covered. Without the cap, a big core
  // would take the fixed 5px tuck and leave the tip 1px proud of its own rim.
  return {
    start: Math.max(0, Math.min(centerRadius * 0.92, centerRadius - tuckDepth(centerRadius, ARTWORK_BAND.core), distance * 0.42)),
    end: Math.max(0, Math.min(nodeRadius - tuckDepth(nodeRadius, ARTWORK_BAND.node), distance * 0.3))
  };
}

export function wireAnchors(center, centerRadius, nodeRadius, x, y) {
  const dx = x - center.x;
  const dy = y - center.y;
  const distance = Math.hypot(dx, dy) || 1;
  const ux = dx / distance;
  const uy = dy / distance;
  // The proportional caps in wireAnchorRadii keep start + end below 0.72 of the
  // span, so the two anchors can never cross how close ever the node is dragged
  // to the core.
  const { start: startR, end: endR } = wireAnchorRadii(centerRadius, nodeRadius, distance);
  return {
    ux,
    uy,
    distance,
    start: {
      x: center.x + ux * startR,
      y: center.y + uy * startR
    },
    end: {
      x: x - ux * endR,
      y: y - uy * endR
    }
  };
}

// The relaxed control point sits on the perpendicular bisector of the wire. A
// pulled wire straightens, so `tension` (0 taut .. 1 relaxed) lets the caller
// flatten the curve while a node is moving fast.
export function wireControl(center, centerRadius, nodeRadius, x, y, bendSign, tension = 1) {
  const { ux, uy, distance, start, end } = wireAnchors(center, centerRadius, nodeRadius, x, y);
  // A cable leaves a housing and enters another, so it only needs enough bow to
  // read as elastic. Anything larger makes ten cables cross into a star.
  const bend = Math.min(12, distance * 0.045) * bendSign * tension;
  return {
    x: (start.x + end.x) / 2 + -uy * bend,
    y: (start.y + end.y) / 2 + ux * bend
  };
}

export function wirePathWithControl(center, centerRadius, nodeRadius, x, y, control) {
  const { start, end } = wireAnchors(center, centerRadius, nodeRadius, x, y);
  return `M ${start.x.toFixed(1)} ${start.y.toFixed(1)} Q ${control.x.toFixed(1)} ${control.y.toFixed(1)} ${end.x.toFixed(1)} ${end.y.toFixed(1)}`;
}

function wirePath(center, centerRadius, nodeRadius, x, y, bendSign) {
  return wirePathWithControl(
    center,
    centerRadius,
    nodeRadius,
    x,
    y,
    wireControl(center, centerRadius, nodeRadius, x, y, bendSign)
  );
}

export function buildCoreLayout(providers, options = {}) {
  const list = Array.isArray(providers) ? providers : [];
  const width = Math.max(300, Number(options.width) || CORE_VIEWBOX.width);
  const height = Math.max(300, Number(options.height) || CORE_VIEWBOX.height);
  const narrow = width < 560;
  const density = coreDensity(list.length);
  const spec = DENSITY[density];
  const nodeSize = narrow ? spec.narrowNode : spec.node;
  const nodeRadius = nodeSize / 2;
  const centerScale = narrow && density === "dense" ? 0.62 : spec.centerScale;
  // The bottom band carries the provider name captions and the status pill, so
  // the ring is kept clear of it rather than letting a label land on top.
  const pad = narrow
    ? { top: 12, right: 14, bottom: 58, left: 14 }
    : { top: 18, right: 22, bottom: 66, left: 22 };
  const availableWidth = width - pad.left - pad.right;
  const availableHeight = height - pad.top - pad.bottom;
  // The core is the focal point, not the page. Holding it under ~0.4 of the
  // shorter axis leaves the harness around it legible instead of dwarfed, but
  // it must still read as the center: two node widths is the floor.
  const centerSize = Math.max(
    Math.round(
      clamp(Math.min(availableWidth, availableHeight) * 0.38, narrow ? 92 : 126, 200) * centerScale
    ),
    Math.ceil(nodeSize * CORE_OVER_NODE)
  );
  const centerRadius = centerSize / 2;
  const center = {
    x: width / 2,
    y: pad.top + availableHeight / 2
  };
  const rx = Math.min(availableWidth * 0.46, availableWidth / 2 - nodeRadius - 10);
  const ry = Math.min(availableHeight * 0.46, availableHeight / 2 - nodeRadius - 10);
  const nodes = [];

  const planned = ringPlan(list.length, { rx, ry, centerRadius, nodeRadius });
  let index = 0;
  planned.forEach((ring, ringIndex) => {
    const ringRx = rx * ring.scale;
    const ringRy = ry * ring.scale;
    for (let step = 0; step < ring.count; step += 1) {
      const provider = list[index];
      if (!provider) break;
      const angle = -Math.PI / 2 + ring.offset + (Math.PI * 2 * step) / Math.max(1, ring.count);
      const x = clamp(
        center.x + Math.cos(angle) * ringRx,
        pad.left + nodeRadius,
        width - pad.right - nodeRadius
      );
      const y = clamp(
        center.y + Math.sin(angle) * ringRy,
        pad.top + nodeRadius,
        height - pad.bottom - nodeRadius
      );
      nodes.push({
        provider,
        key: provider.id,
        index,
        ring: ringIndex,
        angle,
        x,
        y,
        xPct: (x / width) * 100,
        yPct: (y / height) * 100,
        wire: wirePath(center, centerRadius, nodeRadius, x, y, step % 2 === 0 ? 1 : -1),
        withinBounds:
          x - nodeRadius >= pad.left - 2 &&
          x + nodeRadius <= width - pad.right + 2 &&
          y - nodeRadius >= pad.top - 2 &&
          y + nodeRadius <= height - pad.bottom + 2
      });
      index += 1;
    }
  });

  return {
    width,
    height,
    center,
    density,
    nodeSize,
    nodeRadius,
    centerSize,
    centerRadius,
    rings: planned,
    nodes,
    count: nodes.length,
    bounds: {
      minX: pad.left + nodeRadius,
      maxX: width - pad.right - nodeRadius,
      minY: pad.top + nodeRadius,
      maxY: height - pad.bottom - nodeRadius
    }
  };
}

export function wireDots(layout, statusOf = () => "unknown", { maxDots = 14 } = {}) {
  if (!layout?.nodes?.length) return [];
  const workingNodes = layout.nodes.filter(node => statusOf(node.key) === "working");
  if (workingNodes.length === 0) return [];
  const stride = Math.max(1, Math.ceil(workingNodes.length / Math.max(1, maxDots)));
  return workingNodes.filter((_, index) => index % stride === 0);
}
