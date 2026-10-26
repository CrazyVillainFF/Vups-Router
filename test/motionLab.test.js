import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));

const expectedComponents = [
  "AnimatedContent",
  "BlurText",
  "CircularText",
  "ClickSpark",
  "CountUp",
  "DecryptedText",
  "ElectricBorder",
  "FadeContent",
  "GlareHover",
  "GradientText",
  "GradualBlur",
  "LogoLoop",
  "Magnet",
  "PixelTrail",
  "RotatingText",
  "ScrambledText",
  "ScrollFloat",
  "ScrollVelocity",
  "ShinyText",
  "Shuffle",
  "SplitText",
  "SpotlightCard",
  "Stack",
  "StarBorder",
  "TextPressure",
  "TextType",
  "TiltedCard",
  "VariableProximity"
];

test("the motion lab renders at least 20 React Bits components", () => {
  const source = readFileSync(`${root}src/pages/MotionLab.jsx`, "utf8");
  const imported = [
    ...new Set(
      [...source.matchAll(/from "\.\.\/components\/reactbits\/([^/"]+)\/[^"]+"/g)].map(match => match[1])
    )
  ];
  assert.deepEqual(imported.sort(), [...expectedComponents].sort());
  assert.ok(imported.length >= 20);
});

test("every motion lab component ships its source and styles", () => {
  for (const name of expectedComponents) {
    assert.ok(existsSync(`${root}src/components/reactbits/${name}/${name}.jsx`), `${name}.jsx is missing`);
  }
});

test("motion lab is a lazy route and is linked from the footer", () => {
  const app = readFileSync(`${root}src/App.jsx`, "utf8");
  assert.match(app, /React\.lazy\(\(\) => import\("\.\/pages\/MotionLab\.jsx"\)\)/);
  assert.match(app, /path="\/motion"/);
  const footer = readFileSync(`${root}src/components/SiteFooter.jsx`, "utf8");
  assert.match(footer, /<Link to="\/motion">Motion lab<\/Link>/);
});

test("motion and GSAP runtimes are declared", () => {
  const pkg = JSON.parse(readFileSync(`${root}package.json`, "utf8"));
  for (const dependency of ["motion", "gsap", "@gsap/react"]) {
    assert.ok(pkg.dependencies[dependency], `${dependency} must be a dependency`);
  }
});
