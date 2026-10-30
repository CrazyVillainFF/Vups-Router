const target = process.argv[2] || "expr";
const expr = process.argv[3] || "document.location.href";

const port = process.env.QA_CDP_PORT || "9222";
const list = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
const page = list.find((t) => t.type === "page");
if (!page) throw new Error("no page target");

const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });

let id = 0;
const pending = new Map();
ws.onmessage = (ev) => {
  const msg = JSON.parse(ev.data);
  if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); }
};
function send(method, params = {}) {
  const mid = ++id;
  return new Promise((res) => { pending.set(mid, res); ws.send(JSON.stringify({ id: mid, method, params })); });
}

if (target === "reload") {
  await send("Page.reload", {});
  await new Promise((r) => setTimeout(r, 3000));
}

const out = await send("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true });
console.log(JSON.stringify(out.result ?? out, null, 2));
ws.close();
process.exit(0);
