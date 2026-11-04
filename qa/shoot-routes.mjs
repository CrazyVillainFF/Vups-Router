import fs from "node:fs";
import path from "node:path";
import { ROUTES, VIEWPORTS } from "./routes.mjs";
import { baseUrl, launch, newContext, sessionCookie } from "./browser.mjs";

const outDir = path.resolve("qa/baseline");
fs.mkdirSync(outDir, { recursive: true });

const browser = await launch();
const cookie = await sessionCookie();
const origin = baseUrl();
const manifest = [];

for (const viewport of VIEWPORTS) {
  const dir = path.join(outDir, viewport.name);
  fs.mkdirSync(dir, { recursive: true });
  const sizes = { width: viewport.width, height: viewport.height };
  // /signin and /signup bounce to /chat when a session already exists, so the
  // public routes are captured signed out and the app routes signed in.
  const anonymous = await newContext(browser, { viewport: sizes });
  const authenticated = await newContext(browser, { viewport: sizes, cookie });
  for (const route of ROUTES) {
    const context = route.auth ? authenticated : anonymous;
    const page = await context.newPage();
    const errors = [];
    page.on("pageerror", error => errors.push(String(error?.message ?? error)));
    page.on("console", message => {
      if (message.type() === "error") errors.push(message.text());
    });
    const started = Date.now();
    let finalUrl = "";
    try {
      await page.goto(`${origin}${route.path}`, { waitUntil: "load", timeout: 90_000 });
      await page
        .waitForLoadState("networkidle", { timeout: 20_000 })
        .catch(() => undefined);
      // Fonts, the lazy three.js chunk and the catalog fetch all land late.
      await page.waitForTimeout(viewport.name === "1440" ? 2200 : 1400);
      finalUrl = page.url();
      const file = path.join(dir, `${route.name}.png`);
      await page.screenshot({ path: file, fullPage: true });
      manifest.push({
        viewport: viewport.name,
        route: route.path,
        name: route.name,
        auth: route.auth,
        shot: path.relative(outDir, file).replace(/\\/g, "/"),
        finalUrl,
        redirected: !finalUrl.endsWith(route.path),
        ms: Date.now() - started,
        errors: errors.slice(0, 4)
      });
      console.log(`${viewport.name} ${route.path} -> ${finalUrl.replace(origin, "")}`);
    } catch (error) {
      manifest.push({
        viewport: viewport.name,
        route: route.path,
        name: route.name,
        auth: route.auth,
        error: String(error?.message ?? error),
        errors: errors.slice(0, 4)
      });
      console.log(`${viewport.name} ${route.path} FAILED ${String(error?.message ?? error).slice(0, 120)}`);
    } finally {
      await page.close().catch(() => undefined);
    }
  }
  await anonymous.close();
  await authenticated.close();
}

await browser.close();
fs.writeFileSync(path.join(outDir, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
const failed = manifest.filter(entry => entry.error).length;
const redirected = manifest.filter(entry => entry.redirected).length;
console.log(`\n${manifest.length - failed}/${manifest.length} routes captured, ${redirected} redirected`);
