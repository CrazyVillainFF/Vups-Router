import React from "react";
import { stageBlocks } from "./blockStageData.js";

// The hero's static twin: the same seven names the WebGL cluster engraves, as
// real HTML text. It paints instantly, it is what a phone, a reduced-motion
// visitor or a machine without a GL context gets instead of the canvas, and it
// stays in the accessibility tree after the canvas takes over the pixels —
// screen readers never have to trust a render the DOM cannot describe. Each
// tile names what it is in words, so the routed block is not marked by colour
// alone.

export default function StagePoster({ live = false }) {
  return (
    <ul className="vr-poster" data-live={live ? "on" : "off"}>
      {stageBlocks.map(block => (
        <li key={block.name} className="vr-poster__block" data-routed={block.routed ? "on" : "off"}>
          <span className="vr-poster__face">{block.name}</span>
          <span className="vr-poster__kind">{block.kind}</span>
        </li>
      ))}
    </ul>
  );
}
