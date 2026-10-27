import { useReducedMotion } from "motion/react";
import { RollingText3D } from "../lightswind/rolling-text-3d";

/* Lightwind's RollingText3D, wrapped once and reused for the three 3D tubes.
   Inline styles only — the landing Tailwind build does not scan this file,
   and no global rule is added. fontSize="1em" keeps the glyph line inside the
   tube (the tube is 1.2em of this wrapper's font-size). */
export default function RollingTube3D({
  text,
  fontSize = "clamp(11px, 1.15vw, 13px)",
  marginTop = "20px"
}) {
  const reduce = useReducedMotion();

  const box = {
    marginTop,
    fontFamily: "var(--mono)",
    fontSize,
    letterSpacing: ".18em",
    color: "var(--primarylw, #6c9bff)",
    textTransform: "uppercase"
  };

  if (reduce) {
    return (
      <div style={{ ...box, textAlign: "center", lineHeight: 1.2 }}>
        <span>{text}</span>
      </div>
    );
  }

  return (
    <div style={box}>
      <RollingText3D
        text={text}
        fontSize="1em"
        letterSpacing=".18em"
        duration={1.1}
        stagger={0.06}
        perspective={520}
        linesCount={1}
      />
    </div>
  );
}
