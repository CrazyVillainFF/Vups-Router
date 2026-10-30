// QA-only: clicks a link inside the running Windows app with trusted input
// events and reports what the webview did (navigation, new windows, toasts).
// Usage: node scratch/cdp-openlink.mjs <selector> [index]
const PORT = process.env.CDP_PORT || "9222";
const selector = process.argv[2] || "a";
const index = Number(process.argv[3] || 0);

const before = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
const page = before.find(t => t.type === "page" && t.webSocketDebuggerUrl);
if (!page) { console.log("no page target"); process.exit(1); }

const ws = new WebSocket(page.webSocketDebuggerUrl);
let id = 0;
const pending = new Map();
const send = (method, params) => new Promise(res => { const m = ++id; pending.set(m, res); ws.send(JSON.stringify({ id: m, method, params })); });
ws.addEventListener("message", e => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m.result); pending.delete(m.id); } });
const evaluate = async expr => {
  const r = await send("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true });
  if (r?.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails).slice(0, 300));
  return r?.result?.value;
};

const SNAP = `(() => {
  const nodes = [...document.querySelectorAll(${JSON.stringify(selector)})];
  const node = nodes[${index}];
  if (!node) return { found: false, count: nodes.length, url: location.href };
  const r = node.getBoundingClientRect();
  return {
    found: true, count: nodes.length, url: location.href,
    text: (node.textContent || "").trim().slice(0, 40),
    href: node.getAttribute("href"), target: node.getAttribute("target"),
    rect: { x: r.x + r.width / 2, y: r.y + r.height / 2, inView: r.top >= 0 && r.bottom <= innerHeight }
  };
})()`;

const sleep = ms => new Promise(r => setTimeout(r, ms));

ws.addEventListener("open", async () => {
  await send("Runtime.enable", {});
  await send("Page.enable", {});
  await send("Emulation.setDeviceMetricsOverride", { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
  // scroll the element into view, then wait for smooth scrolling to settle
  await evaluate(`(() => { const n = [...document.querySelectorAll(${JSON.stringify(selector)})][${index}]; n && n.scrollIntoView({block:'center', behavior:'instant'}); return 1; })()`);
  await sleep(900);
  let info = (await evaluate(SNAP));
  console.log("element:", JSON.stringify(info));
  if (!info.found) { ws.close(); process.exit(0); }
  const toastBefore = await evaluate(`document.body.innerText.slice(0,1200)`);
  await send("Input.dispatchMouseEvent", { type: "mouseMoved", x: info.rect.x, y: info.rect.y });
  await send("Input.dispatchMouseEvent", { type: "mousePressed", x: info.rect.x, y: info.rect.y, button: "left", clickCount: 1 });
  await send("Input.dispatchMouseEvent", { type: "mouseReleased", x: info.rect.x, y: info.rect.y, button: "left", clickCount: 1 });
  await sleep(4000);
  const after = await evaluate(`({ url: location.href, targets: document.querySelectorAll('iframe').length, toast: [...document.querySelectorAll('[role=alert],.MuiAlert-root')].map(n=>n.innerText).join(' | ') })`);
  const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
  console.log("after:", JSON.stringify(after));
  console.log("webview windows:", list.filter(t => t.type === "page").map(t => t.url).join(", "));
  console.log("toast before:", JSON.stringify(toastBefore.slice(-160)));
  ws.close();
  process.exit(0);
});
