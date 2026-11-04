import React from "react";

// A 3 per cent film of noise over the whole page, so the graphite reads as a
// material instead of a flat fill. It is painted from the same inline SVG the
// app's Blocks layer already uses, it never animates, and it cannot be clicked.

export default function GrainOverlay() {
  return <div className="vr-grain" aria-hidden="true" />;
}
