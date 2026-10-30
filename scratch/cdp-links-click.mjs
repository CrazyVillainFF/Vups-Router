// Clicks an element in the running Windows app via trusted CDP mouse events.
// Usage: node scratch/cdp-links-click.mjs <selector-json> [index]
const PORT = process.env.CDP_PORT || "9222";
const selector = JSON.parse(process.argv[2] || '"a[href]"');
const index = Number(process.argv[3] || 0);
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
  try {
    await send("Runtime.enable", {});
    await send("Page.enable", {});
    const info = await evaluate(`(() => {
      const nodes = [...document.querySelectorAll(${JSON.stringify(selector)})];
      const node = nodes[${index}];
      if (!node) return { found: false, count: nodes.length, url: location.href };
      node.scrollIntoView({ block: "center" });
      const r = node.getBoundingClientRect();
      return {
        found: true,
        count: nodes.length,
        url: location.href,
        text: (node.textContent || "").trim().slice(0, 60),
        href: node.getAttribute("href"),
        target: node.getAttribute("target"),
        rect: { x: r.x + r.width / 2, y: r.y + r.height / 2, w: r.width, h: r.height }
      };
    })()`);
    console.log("element:", JSON.stringify(info));
    if (!info.found) process.exit(0);
    await sleep(400);
    const { x, y } = info.rect;
    await send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y });
    await send("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", clickCount: 1 });
    await send("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", clickCount: 1 });
    await sleep(2500);
    const after = await evaluate(`({ url: location.href, title: document.title, path: location.pathname + location.search })`);
    console.log("after:", JSON.stringify(after));
  } catch (error) {
    console.log("cdp error:", error.message);
  } finally {
    ws.close();
  }
});
