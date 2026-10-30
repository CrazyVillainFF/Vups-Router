// QA-only CDP driver for a dedicated Chrome instance (remote debugging port
// 9223). Lets the desktop handoff be exercised with a real browser on the
// website side without touching the user's own browser windows.
//   node scratch/cdp-chrome.mjs tabs
//   node scratch/cdp-chrome.mjs open <url>
//   node scratch/cdp-chrome.mjs eval <targetPrefix> <expression>
//   node scratch/cdp-chrome.mjs click <targetPrefix> <selector> [index]
//   node scratch/cdp-chrome.mjs type <targetPrefix> <selector> <index> <text>
const PORT = process.env.CDP_PORT || "9223";
const BASE = `http://127.0.0.1:${PORT}`;
const [command, a, b, c, d] = process.argv.slice(2);

async function targets() {
  return (await (await fetch(`${BASE}/json/list`)).json()).filter(t => t.type === "page");
}

function pick(list, prefix) {
  return list.find(t => t.id.startsWith(prefix) || t.url.includes(prefix));
}

async function newTab(url) {
  const put = await fetch(`${BASE}/json/new?${encodeURIComponent(url)}`, { method: "PUT" });
  if (!put.ok) throw new Error(`json/new failed: ${put.status}`);
  return put.json();
}

function connect(page) {
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  let id = 0;
  const pending = new Map();
  ws.addEventListener("message", event => {
    const msg = JSON.parse(event.data);
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      msg.error ? reject(new Error(JSON.stringify(msg.error))) : resolve(msg.result);
    }
  });
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const mid = ++id;
    pending.set(mid, { resolve, reject });
    ws.send(JSON.stringify({ id: mid, method, params }));
  });
  const ready = new Promise((resolve, reject) => {
    ws.addEventListener("open", resolve);
    ws.addEventListener("error", () => reject(new Error("websocket failed")));
  });
  const evaluate = async expression => {
    const r = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails.exception?.description || r.exceptionDetails).slice(0, 400));
    return r.result?.value;
  };
  return { ws, send, ready, evaluate, close: () => ws.close() };
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

if (command === "tabs") {
  for (const t of await targets()) console.log(`${t.id.slice(0, 8)} | ${t.title.slice(0, 40)} | ${t.url}`);
  process.exit(0);
}

if (command === "open") {
  const tab = await newTab(a);
  console.log(`${tab.id.slice(0, 8)} | ${tab.url}`);
  process.exit(0);
}

if (command === "close") {
  const list = await targets();
  const page = pick(list, a);
  if (!page) throw new Error("no such tab");
  await fetch(`${BASE}/json/close/${page.id}`);
  console.log("closed", page.id.slice(0, 8));
  process.exit(0);
}

const page = pick(await targets(), a);
if (!page) throw new Error(`no tab matches ${a}`);
const client = connect(page);
await client.ready;
await client.send("Runtime.enable");
await client.send("Page.enable");

if (command === "eval") {
  console.log(JSON.stringify(await client.evaluate(b)));
} else if (command === "click") {
  const info = await client.evaluate(`(() => {
    const n = [...document.querySelectorAll(${JSON.stringify(b)})][${Number(c || 0)}];
    if (!n) return { found: false, count: document.querySelectorAll(${JSON.stringify(b)}).length };
    n.scrollIntoView({ block: "center", behavior: "instant" });
    const r = n.getBoundingClientRect();
    return { found: true, text: (n.textContent || n.value || "").trim().slice(0, 40), rect: { x: r.x + r.width / 2, y: r.y + r.height / 2 } };
  })()`);
  if (!info?.found) { console.log("not found:", JSON.stringify(info)); process.exit(1); }
  await sleep(200);
  const { x, y } = info.rect;
  await client.send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y });
  await client.send("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", clickCount: 1 });
  await client.send("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", clickCount: 1 });
  console.log("clicked", JSON.stringify(info));
} else if (command === "type") {
  const ok = await client.evaluate(`(() => {
    const n = [...document.querySelectorAll(${JSON.stringify(b)})][${Number(c)}];
    if (!n) return false;
    const proto = n.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, 'value').set;
    setter.call(n, ${JSON.stringify(d ?? "")});
    n.dispatchEvent(new Event('input', { bubbles: true }));
    n.dispatchEvent(new Event('change', { bubbles: true }));
    return n.value;
  })()`);
  console.log("typed", JSON.stringify(ok));
} else if (command === "wait") {
  await sleep(Number(b || 2000));
  console.log(JSON.stringify(await client.evaluate(`({ url: location.href, title: document.title })`)));
}

client.close();
process.exit(0);
