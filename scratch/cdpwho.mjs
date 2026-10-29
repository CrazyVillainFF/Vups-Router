const CDP = "http://127.0.0.1:9223";
const list = await (await fetch(`${CDP}/json/list`)).json();
const page = list.find(t => t.type === "page" && t.url.includes("/chat?native=windows"));
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((r, j) => { ws.addEventListener("open", r, { once: true }); ws.addEventListener("error", j, { once: true }); });
let id = 0; const pending = new Map();
ws.addEventListener("message", e => { const m = JSON.parse(e.data); const s = pending.get(m.id); if (s) { pending.delete(m.id); s(m); } });
const send = (method, params = {}) => new Promise(res => { const n = ++id; pending.set(n, res); ws.send(JSON.stringify({ id: n, method, params })); });
const expression = `(async () => {
  const me = await fetch("/api/auth/me", { credentials: "include" });
  const meText = await me.text();
  const res = await fetch("/api/chat", {
    method: "POST", credentials: "include",
    headers: { "Content-Type": "application/json", Accept: "text/event-stream" },
    body: JSON.stringify({ messages: [{ role: "user", content: "hi" }], model: "recursive/flint-v1.0:free", stream: true })
  });
  const body = await res.text();
  const shared = await fetch("/api/models/shared", { credentials: "include" });
  const sharedText = await shared.text();
  return JSON.stringify({ me: me.status, meBody: meText.slice(0, 220), chat: res.status, chatBody: body.slice(0, 900), shared: shared.status, sharedBody: sharedText.slice(0, 900) }, null, 2);
})()`;
const r = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
console.log(r.result?.result?.value ?? JSON.stringify(r).slice(0, 900));
ws.close();
