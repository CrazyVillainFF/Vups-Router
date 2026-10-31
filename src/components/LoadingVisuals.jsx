import { Bouncy } from "ldrs/react";
import "ldrs/react/Bouncy.css";
import { Quantum } from "ldrs/react";
import "ldrs/react/Quantum.css";
import "./LoadingVisuals.css";

// Both loaders read the theme through --vr-loader-color so a single token
// change recolors every waiting state. Sizes stay compact so the markers fit
// the 30px activity head and page captions without dominating them.

export function QuantumLoader({ label = "Loading", decorative = false, className = "" }) {
  return (
    <div
      className={`vr-loader vr-loader--quantum${className ? ` ${className}` : ""}`}
      {...(decorative
        ? { "aria-hidden": "true" }
        : { role: "status", "aria-label": label })}
    >
      <Quantum size="30" speed="1.75" color="var(--vr-loader-color, var(--accent, #6c9bff))" />
    </div>
  );
}

export function ThinkingBouncy({ className = "" }) {
  return (
    <span
      className={`vr-loader vr-loader--bouncy${className ? ` ${className}` : ""}`}
      aria-hidden="true"
    >
      <Bouncy size="22" speed="1.75" color="var(--vr-loader-color, var(--accent, #6c9bff))" />
    </span>
  );
}
