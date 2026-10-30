// Sequentially clicks internal router links in the running app and reports navigation results.
const PORT = process.env.CDP_PORT || "9222";
const targets = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
const page = targets.find(t => t.type === "page" && t.webSocketDebuggerUrl);
if (!page) {
  console.log("no page target");
  process.exit(1);
}
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
  const r = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true, timeout: 20000 });
  if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails));
  return r.result.value;
};
const sleep = ms => new Promise(r => setTimeout(r, ms));

ws.addEventListener("open", async () => {
  const errors = [];
  try {
    await send("Runtime.enable", {});
    await send("Page.enable", {});
    // capture console errors through evaluation of a hook as Runtime events are not subscribed below
    const routes = ["/plugins", "/help", "/settings", "/app-settings", "/account", "/automations", "/chat"];
    for (const route of routes) {
      const result = await evaluate(`(async () => {
        const link = [...document.querySelectorAll('a[href="${route}"]')][0];
        if (!link) return { route: "${route}", found: false, from: location.pathname };
        link.scrollIntoView({ block: "center" });
        const r = link.getBoundingClientRect();
        return { route: "${route}", found: true, from: location.pathname, x: r.x + r.width / 2, y: r.y + r.height / 2 };
      })()`);
      if (!result.found) {
        console.log("MISSING link", route, "from", result.from);
        continue;
      }
      await sleep(200);
      await send("Input.dispatchMouseEvent", { type: "mousePressed", x: result.x, y: result.y, button: "left", clickCount: 1 });
      await send("Input.dispatchMouseEvent", { type: "mouseReleased", x: result.x, y: result.y, button: "left", clickCount: 1 });
      await sleep(900);
      const after = await evaluate(`({ path: location.pathname + location.search, heading: (document.querySelector("h1,h2")?.textContent || "").trim().slice(0, 50), shell: document.documentElement.className })`);
      console.log(`${route.padEnd(14)} from ${result.from.padEnd(14)} -> ${after.path} | h=${after.heading}`);
    }
    // lazy route
    await evaluate(`location.href = "/motion"; "go"`).catch(() => {});
    await sleep(2500);
    console.log("motion:", JSON.stringify(await evaluate(`({ path: location.pathname, text: (document.body.innerText || "").slice(0, 120) })`)));
  } catch (error) {
    console.log("cdp error:", error.message);
  } finally {
    if (errors.length) console.log("errors:", errors);
    ws.close();
  }
});
