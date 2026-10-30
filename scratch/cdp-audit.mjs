// Captures screenshots of the running desktop app at chosen widths.
import { mkdir, writeFile } from "node:fs/promises";
const CDP_PORT = process.env.CDP_PORT || "9224";
const OUT = process.env.OUT_DIR || "scratch/audit";
const targets = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`)).json();
const page = targets.find(t => t.type === "page" && t.webSocketDebuggerUrl);
const ws = new WebSocket(page.webSocketDebuggerUrl);
let id = 0;
const pending = new Map();
const send = (method, params) =>
  new Promise((resolve, reject) => {
    const msgId = ++id;
    pending.set(msgId, { resolve, reject });
    ws.send(JSON.stringify({ id: msgId, method, params }));
  });
ws.addEventListener("message", event => {
  const msg = JSON.parse(event.data);
  if (msg.id && pending.has(msg.id)) {
    const { resolve, reject } = pending.get(msg.id);
    pending.delete(msg.id);
    if (msg.error) reject(new Error(JSON.stringify(msg.error)));
    else resolve(msg.result);
  }
});
const evaluate = async expression => {
  const r = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true, timeout: 30000 });
  if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails));
  return r.result.value;
};
const sleep = ms => new Promise(r => setTimeout(r, ms));

const shots = (process.env.SHOTS || "/chat@1440,/settings@1440,/app-settings@1440,/account@1440,/automations@1440,/help@1440,/chat@1024,/settings@1024")
  .split(",")
  .map(spec => spec.split("@"));

ws.addEventListener("open", async () => {
  await mkdir(OUT, { recursive: true });
  try {
    await send("Page.enable", {});
    for (const [path, width] of shots) {
      const w = Number(width);
      await send("Emulation.setDeviceMetricsOverride", { width: w, height: 900, deviceScaleFactor: 1, mobile: false });
      if ((await evaluate("location.pathname")) !== path) {
        await evaluate(`location.href = ${JSON.stringify(path + "?native=windows")}; "nav"`).catch(() => {});
        await sleep(2600);
      }
      await sleep(900);
      const { data } = await send("Page.captureScreenshot", { format: "png", captureBeyondViewport: false });
      const name = `${path.replace(/\//g, "") || "root"}-${w}.png`;
      await writeFile(`${OUT}/${name}`, Buffer.from(data, "base64"));
      const info = await evaluate(`JSON.stringify({ path: location.pathname, h: document.documentElement.scrollHeight, overflowX: document.documentElement.scrollWidth > innerWidth })`);
      console.log(name, info);
    }
    await send("Emulation.clearDeviceMetricsOverride", {});
  } catch (error) {
    console.log("ERR", error.message);
  } finally {
    ws.close();
  }
});
