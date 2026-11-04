/* ── the design gate, expressed as linter rules ────────────────────────────────
   Only the four bans that are expressible in CSS are here: a raw hex, a gradient
   that paints, backdrop-filter, and a blurred shadow. Everything else the design
   system forbids lives in JS or in the browser (Tailwind classes, inline styles,
   3D materials, computed colours) and is checked by qa/guard-*.mjs, which share
   qa/color-rules.mjs with the census. No stylistic rules are enabled: a linter
   that reports five hundred formatting notes buries the four findings that matter,
   and the first person to need a clean run switches it off. */
import offsetShadow from "./qa/stylelint-hard-offset-shadow.mjs";

export default {
  plugins: [offsetShadow],
  rules: {
    /* Naming a colour is legal in exactly one file; see the override below. */
    "color-no-hex": true,

    /* A gradient on a mask property clips; on anything else it paints, which the
       token system bans. The property regex is the whole distinction, so a
       `mask-image: linear-gradient(…)` stays legal geometry. */
    "declaration-property-value-disallowed-list": {
      "/^(?!.*mask)/i": ["/gradient\\(/i"],
      "/backdrop-filter$/i": ["/^(?!none$)/i"]
    },

    "vupsrouter/hard-offset-shadow": true
  },
  overrides: [
    {
      /* The token layer is where a colour is *defined*; banning a hex there would
         mean defining tokens with no values. qa/guard-no-hex.mjs checks this file
         against src/tokens.js instead, so the pairing is enforced, not waived. */
      files: ["src/tokens.css"],
      rules: { "color-no-hex": null }
    }
  ]
};
