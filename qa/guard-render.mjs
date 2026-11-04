/* ── the rendered guards ────────────────────────────────────────────────────────
   Three of the five P1 gates run against the live dev server, in a real browser,
   in both themes, on every route the router can reach:

     blue      guard 2 — no computed colour in the banned blue family
     clip      guard 3 — no box cut off by the viewport except in a scroll region
     contrast  guard 4 — the custom WCAG walk, plus axe-core's own colour audit
     paint     extra evidence (a library's blurred elevation, a runtime gradient)

   The measurements come from qa/render-probe.js. A route that cannot be reached
   is reported with the reason it could not be reached — never counted as passing.

     node qa/guard-render.mjs [--only=blue,clip,contrast,paint]
                              [--theme=dark|light] [--viewport=1440]
                              [--routes=chat,combo] [--settle=ms]

   Authenticated routes need QA_EMAIL/QA_PASSWORD. Without them this script says
   which routes it could not test and why, and still runs the public set. */
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { ROUTES, THEMES, VIEWPORTS } from "./routes.mjs";
import { baseUrl, launch, newContext, sessionCookie } from "./browser.mjs";

const require = createRequire(import.meta.url);
const arg = (name, fallback = null) => {
  const hit = process.argv.find(value => value.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
};
const list = value => String(value).split(",").map(entry => entry.trim()).filter(Boolean);

const checks = list(arg("only", "blue,clip,contrast,paint"));
const themeFilter = arg("theme");
const viewportFilter = arg("viewport");
const routeFilter = arg("routes");
const settle = Number(arg("settle", 2200));
const axePath = require.resolve("axe-core/axe.min.js");

const wanted = checks.includes("clip") ? VIEWPORTS : VIEWPORTS.filter(entry => entry.name === "1440");
const viewports = wanted.filter(entry => !viewportFilter || entry.name === viewportFilter);
const themes = THEMES.filter(theme => !themeFilter || theme === themeFilter);
const routes = ROUTES.filter(
  route => !routeFilter || list(routeFilter).some(name => route.name === name || route.path === `/${name}`)
);

/* The addendum names the two wash-out reference colours outright, so they are
   handed to the probe as colours and measured with the walk's own luminance
   function rather than being converted here into a second, drifting constant. */
const WASH_LIMIT = { ink: "#CFCBC0", background: "#E0DCD0" };

const browser = await launch();
/* Installed before every navigation, so the probe is in place whatever the page
   does later; it only ever reads, never mutates. */
const withProbe = async context => {
  await context.addInitScript({ path: path.resolve("qa/render-probe.js") });
  return context;
};
const origin = baseUrl();
let cookie = null;
let authNote = "signed in through POST /api/auth/signin (throwaway QA account)";
try {
  cookie = await sessionCookie();
} catch (error) {
  authNote = `not signed in — ${String(error.message ?? error)}`;
}

/* ── self-test: prove the walks can fail ─────────────────────────────────────────
   A rendered guard that measures nothing reports the same zero as a rendered guard
   with nothing to report. This injects the exact defects the design system bans
   into a live page, in both themes, and asserts each one is caught — including
   that the third-party brand exemption hides a blurple swatch from the blue walk,
   and that the wash-out rule fires in light only (its dark-theme twin would fail
   the palette's own body ink). The fixture is removed afterwards; nothing is
   written to any file but qa/audit/guard-self-test.json. */
const FIXTURE = `
  <div id="qa-guard-fixture" style="position:relative">
    <p id="fx-blue" style="color:#2b6cff;background:#ffffff;padding:4px">blue ink</p>
    <p id="fx-washed" style="color:#8a8a8a;background:#9a9a9a;padding:4px">washed pair</p>
    <p id="fx-light-ink" style="color:#e8e5de;background:#1a1917;padding:4px">bright ink on dark</p>
    <span id="fx-brand" data-brand="third-party identity" style="display:block;width:48px;height:20px;background:#5865f2"></span>
    <div id="fx-clip" style="position:fixed;left:-160px;top:120px;width:320px;height:16px;background:#ff5b1f"></div>
    <div id="fx-gradient" style="height:12px;background:linear-gradient(90deg,#ffffff,#000000)"></div>
    <div id="fx-shadow" style="height:12px;box-shadow:0 4px 12px rgba(0,0,0,0.4)"></div>
  </div>`;

async function selfTest(browser) {
  const viewport = { width: 1440, height: 900 };
  const cases = [];
  const record = (name, passed, detail = "") => cases.push({ name, passed, detail });

  for (const theme of ["dark", "light"]) {
    /* /features is public, so the self-test needs no session: the defect it is
       looking for is in the walk, not in the route. */
    const context = await withProbe(await newContext(browser, { viewport, theme }));
    const page = await context.newPage();
    await page.goto(`${origin}/features`, { waitUntil: "load", timeout: 90_000 });
    await page.waitForLoadState("networkidle", { timeout: 20_000 }).catch(() => undefined);
    await page.waitForTimeout(800);
    const clean = await page.evaluate(limit => ({
      blue: window.__qaProbe.blue().found.length,
      clip: window.__qaProbe.clip().found.length,
      contrast: window.__qaProbe.contrast(limit).found.length,
      paint:
        window.__qaProbe.paint().shadows.length +
        window.__qaProbe.paint().gradients.length +
        window.__qaProbe.paint().filters.length
    }), WASH_LIMIT);

    await page.evaluate(fixture => {
      const host = document.createElement("div");
      host.innerHTML = fixture;
      document.body.append(host.firstElementChild);
    }, FIXTURE);

    const hit = await page.evaluate(limit => {
      const blue = window.__qaProbe.blue();
      const clip = window.__qaProbe.clip();
      const contrast = window.__qaProbe.contrast(limit);
      const paint = window.__qaProbe.paint();
      const names = items => items.map(item => String(item.where ?? ""));
      return {
        blueFixtures: names(blue.found).filter(where => where.includes("fx-blue")).length,
        brandSwatchFlagged: names(blue.found).some(where => where.includes("fx-brand")),
        clipBox: names(clip.found).filter(where => where.includes("fx-clip")).length,
        washed: names(contrast.found).filter(where => where.includes("fx-washed")).length,
        lightInk: (() => {
          const entry = contrast.found.find(item => String(item.where).includes("fx-light-ink"));
          return entry ? (entry.flags ?? []).join("|") : "not reported";
        })(),
        gradients: paint.gradients.filter(item => item.where.includes("fx-gradient")).length,
        shadows: paint.shadows.filter(item => item.where.includes("fx-shadow")).length,
        totals: {
          blue: blue.found.length,
          clip: clip.found.length,
          contrast: contrast.found.length,
          paint: paint.shadows.length + paint.gradients.length + paint.filters.length
        }
      };
    }, WASH_LIMIT);

    /* Differential, not absolute: the page's own pre-existing violations stay in
       the baseline line and the planted ones have to move every counter. */
    cases.push({ name: `${theme}: baseline before the fixture`, passed: true, detail: JSON.stringify(clean) });
    for (const key of ["blue", "clip", "contrast", "paint"]) {
      record(
        `${theme}: ${key} walk counts the planted defect`,
        hit.totals[key] > clean[key],
        `${clean[key]} → ${hit.totals[key]}`
      );
    }
    record(`${theme}: blue ink detected`, hit.blueFixtures >= 1, `found ${hit.blueFixtures}`);
    record(`${theme}: third-party brand swatch is exempt`, !hit.brandSwatchFlagged, hit.brandSwatchFlagged ? "flagged" : "skipped");
    record(`${theme}: fixed box past the viewport detected`, hit.clipBox >= 1, `found ${hit.clipBox}`);
    record(`${theme}: sub-AA text pair detected`, hit.washed >= 1, `found ${hit.washed}`);
    record(`${theme}: runtime blurred shadow detected`, hit.shadows >= 1, `found ${hit.shadows}`);
    record(`${theme}: runtime gradient paint detected`, hit.gradients >= 1, `found ${hit.gradients}`);
    record(
      `${theme}: wash-out rule ${theme === "light" ? "fires on near-white ink" : "stays dark-theme-off (documented deviation)"}`,
      theme === "light" ? hit.lightInk.includes("washed out") : !hit.lightInk.includes("washed out"),
      hit.lightInk
    );

    await page.evaluate(() => document.getElementById("qa-guard-fixture")?.remove());
    await page.close();
    await context.close();
  }

  fs.mkdirSync("qa/audit", { recursive: true });
  fs.writeFileSync("qa/audit/guard-self-test.json", `${JSON.stringify(cases, null, 2)}\n`);
  const missed = cases.filter(entry => !entry.passed);
  for (const entry of cases) console.log(`  ${entry.passed ? "caught  " : "MISSED  "} ${entry.name}${entry.detail ? ` — ${entry.detail}` : ""}`);
  console.log(
    missed.length
      ? `\nguard-render self-test: FAIL (${missed.length}/${cases.length} defects not detected)`
      : `\nguard-render self-test: PASS (${cases.length}/${cases.length} planted defects detected)`
  );
  return missed.length ? 1 : 0;
}

if (process.argv.includes("--self-test")) {
  const code = await selfTest(browser);
  await browser.close();
  process.exit(code);
}

const results = [];
const failures = [];
const skipped = [];

for (const viewport of viewports) {
  const sizes = { width: viewport.width, height: viewport.height };
  for (const theme of themes) {
    const anonymous = await withProbe(await newContext(browser, { viewport: sizes, theme }));
    const authenticated = cookie
      ? await withProbe(await newContext(browser, { viewport: sizes, theme, cookie }))
      : null;
    for (const route of routes) {
      if (route.auth && !authenticated) {
        skipped.push({
          route: route.path,
          theme,
          viewport: viewport.name,
          reason: `requires a session cookie and ${authNote}`
        });
        continue;
      }
      const context = route.auth ? authenticated : anonymous;
      const page = await context.newPage();
      const errors = [];
      page.on("pageerror", error => errors.push(String(error?.message ?? error)));
      page.on("console", message => {
        if (message.type() === "error") errors.push(message.text());
      });
      const entry = { route: route.path, name: route.name, theme, viewport: viewport.name, checks: {} };
      try {
        await page.goto(`${origin}${route.path}`, { waitUntil: "load", timeout: 90_000 });
        await page.waitForLoadState("networkidle", { timeout: 20_000 }).catch(() => undefined);
        await page.waitForTimeout(settle);
        await page.evaluate(() => document.fonts.ready);
        entry.finalUrl = page.url();
        entry.redirected = !entry.finalUrl.endsWith(route.path);
        if (entry.redirected) {
          entry.checks.redirect = { to: entry.finalUrl.replace(origin, "") };
          skipped.push({
            route: route.path,
            theme,
            viewport: viewport.name,
            reason: `served ${entry.finalUrl.replace(origin, "")} instead`
          });
          continue;
        }
        /* Reveal lazy content: the landing and motion pages mount their lower
           sections, and their 3D chunk, only once they scroll. */
        await page.evaluate(async () => {
          const height = document.documentElement.scrollHeight;
          for (let y = 0; y < height; y += Math.round(window.innerHeight * 0.8)) {
            window.scrollTo(0, y);
            await new Promise(resolve => setTimeout(resolve, 120));
          }
          window.scrollTo(0, 0);
          await new Promise(resolve => setTimeout(resolve, 400));
        });

        if (checks.includes("blue")) {
          const { found, brandExempt } = await page.evaluate(() => window.__qaProbe.blue());
          entry.checks.blue = { count: found.length, brandExempt, items: found };
          for (const item of found) {
            failures.push(`blue  ${route.path} [${theme} @${viewport.name}]  ${item.property} ${item.value}  at ${item.where}`);
          }
        }
        if (checks.includes("clip")) {
          const report = await page.evaluate(() => window.__qaProbe.clip());
          entry.checks.clip = {
            count: report.found.length,
            document: report.document,
            items: report.found
          };
          for (const item of report.found) {
            failures.push(
              `clip  ${route.path} [${theme} @${viewport.name}]  box ${item.side}=${item.box[item.side]} outside 0…${item.viewport}  at ${item.where}`
            );
          }
          if (report.document.scrollWidth > report.document.clientWidth + 1) {
            failures.push(
              `clip  ${route.path} [${theme} @${viewport.name}]  the document itself scrolls sideways (${report.document.scrollWidth} > ${report.document.clientWidth})`
            );
          }
        }
        if (checks.includes("contrast")) {
          const report = await page.evaluate(limit => window.__qaProbe.contrast(limit), WASH_LIMIT);
          /* Every finding is kept: the addendum asks for element/fg/bg/ratio/route
             per violation, and a tally alone cannot be checked by whoever fixes it.
             byFlag separates the WCAG ratio failures from the wash-out flags so a
             reader can see which of the two rules a count came from. */
          const byFlag = {};
          for (const item of report.found) {
            for (const flag of item.flags ?? ["unparseable colour"]) byFlag[flag] = (byFlag[flag] ?? 0) + 1;
          }
          entry.checks.contrast = {
            checked: report.checked,
            count: report.found.length,
            byFlag,
            paintedSkipped: report.painted.length,
            items: report.found
          };
          for (const item of report.found) {
            failures.push(
              `contrast  ${route.path} [${theme} @${viewport.name}]  ${(item.flags ?? ["unparseable"]).join(", ")}  ${item.ratio ?? "n/a"}:1 need ${item.need ?? "?"}  ${item.ink ?? "?"} on ${item.behind ?? "?"}  at ${item.where}  "${item.text ?? ""}"`
            );
          }
          await page.addScriptTag({ path: axePath });
          const axe = await page.evaluate(async () =>
            window.axe.run(document, {
              runOnly: { type: "rule", values: ["color-contrast"] },
              resultTypes: ["violations"]
            })
          );
          entry.checks.axe = {
            count: axe.violations.length,
            nodes: axe.violations.reduce((total, violation) => total + violation.nodes.length, 0),
            items: axe.violations.map(violation => ({
              id: violation.id,
              impact: violation.impact,
              nodes: violation.nodes.length,
              first: violation.nodes[0]?.html?.slice(0, 120) ?? "",
              all: violation.nodes.map(node => node.html.slice(0, 160))
            }))
          };
          for (const violation of axe.violations) {
            for (const node of violation.nodes.slice(0, 6)) {
              failures.push(
                `axe  ${route.path} [${theme} @${viewport.name}]  ${violation.id} (${violation.impact})  ${node.html.slice(0, 110)}`
              );
            }
          }
        }
        if (checks.includes("paint")) {
          const report = await page.evaluate(() => window.__qaProbe.paint());
          /* Paint findings are the P2 work list, not one of the five gates, and a
             page can contain the same MUI shadow on forty nodes. The counts stay
             exact; the items are deduplicated by value so the list names each
             distinct defect once and says how many nodes carry it. */
          const worklist = [];
          const seen = new Map();
          for (const [kind, list] of [
            ["blurred shadow", report.shadows],
            ["gradient paint", report.gradients],
            ["backdrop/blur filter", report.filters]
          ]) {
            for (const item of list) {
              const key = `${kind}\u0000${item.value}`;
              const existing = seen.get(key);
              if (existing) {
                existing.nodes += 1;
                continue;
              }
              const row = { kind, nodes: 1, value: item.value, where: item.where };
              seen.set(key, row);
              worklist.push(row);
            }
          }
          entry.checks.paint = {
            shadows: report.shadows.length,
            gradients: report.gradients.length,
            filters: report.filters.length,
            distinct: worklist.length,
            items: worklist
          };
        }
        entry.errors = errors.slice(0, 4);
      } catch (error) {
        entry.error = String(error?.message ?? error);
        skipped.push({ route: route.path, theme, viewport: viewport.name, reason: entry.error });
      } finally {
        await page.close().catch(() => undefined);
      }
      results.push(entry);
      const summary = Object.entries(entry.checks)
        .filter(([, value]) => typeof value === "object")
        .map(([key, value]) => `${key}=${value.count ?? 0}`)
        .join(" ");
      console.log(
        `${viewport.name} ${theme} ${route.path}${entry.error ? ` FAILED ${entry.error.slice(0, 80)}` : ` ${summary}`}`
      );
    }
    await anonymous.close();
    if (authenticated) await authenticated.close();
  }
}

await browser.close();

const paintCount = results.reduce(
  (total, entry) =>
    entry.checks.paint
      ? total + entry.checks.paint.shadows + entry.checks.paint.gradients + entry.checks.paint.filters
      : total,
  0
);

fs.mkdirSync("qa/audit", { recursive: true });
fs.writeFileSync(
  "qa/audit/guard-render.json",
  `${JSON.stringify(
    {
      generatedBy: "qa/guard-render.mjs",
      checks,
      themes,
      viewports: viewports.map(entry => entry.name),
      auth: authNote,
      washLimitDeviation:
        "the light-ink / light-background rules are evaluated in the light theme only; in dark they would fail --text (#edeae3), which is the palette's own body ink",
      skipped,
      results,
      failures
    },
    null,
    2
  )}\n`
);

console.log(`\nrendered guards — ${results.length} route/theme/viewport pages walked`);
if (skipped.length) {
  console.log(`\nnot tested (${skipped.length}):`);
  for (const item of skipped) console.log(`  ${item.route} [${item.theme} @${item.viewport}] — ${item.reason}`);
}
if (paintCount) {
  console.log(
    `\npaint evidence (not one of the five gates, it is the P2 work list): ${paintCount} runtime-blurred/gradient/filter paints`
  );
}
if (failures.length) {
  console.log(`\nFAIL — ${failures.length} rendered violations:`);
  for (const failure of failures.slice(0, 80)) console.log(`  ${failure}`);
  if (failures.length > 80) console.log(`  … ${failures.length - 80} more in qa/audit/guard-render.json`);
  console.log("\nguard-render: FAIL");
  process.exit(1);
}
console.log("guard-render: PASS");
