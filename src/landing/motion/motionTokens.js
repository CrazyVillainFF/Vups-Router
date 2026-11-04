import { gsap } from "gsap";
import { CustomEase } from "gsap/CustomEase";

/* One motion vocabulary for the three redesigned surfaces.

   The brief names a single curve — cubic-bezier(0.16, 1, 0.3, 1) — and GSAP's
   CustomEase accepts that exact notation, so the authored curve and the CSS
   curve are the same object rather than two approximations of it. CustomEase
   and every other plugin used here ships in the public gsap package; none of
   them needs a licence key.

   Durations follow the brief's ladder: micro feedback 100–150ms, hover and
   state 150–250ms, section transitions 300–500ms, hero stages 500–800ms. */

gsap.registerPlugin(CustomEase);

export const EASE = CustomEase.create("vups-expo", "0.16, 1, 0.3, 1");
export const EASE_SOFT = CustomEase.create("vups-soft", "0.22, 0.8, 0.28, 1");
export const EASE_DRAW = CustomEase.create("vups-draw", "0.65, 0, 0.35, 1");

export const D = {
  micro: 0.14,
  state: 0.22,
  section: 0.44,
  stage: 0.7,
  scene: 1.6
};

export const STAGGER = {
  card: 0.08,
  line: 0.045,
  node: 0.07
};

/* The CSS mirror of EASE, for the transitions the stylesheet owns (focus,
   hover, button press) so DOM and GSAP motion read as one system. */
export const CSS_EASE = "cubic-bezier(0.16, 1, 0.3, 1)";

export default { EASE, EASE_SOFT, EASE_DRAW, D, STAGGER, CSS_EASE };
