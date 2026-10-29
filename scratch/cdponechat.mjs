const CDP = "http://127.0.0.1:9223/json/list";

const EXPRESSION = `(async () => {
  const body = {
    model: "vups-v3-galax",
    stream: true,
    mode: "general",
    temperature: 0.7,
    assistantMessageId: "diag_" + Date.now(),
    messages: [{ role: "user", content: "Reply with exactly: VupsRouter works." }]
  };
  const started = Date.now();
  const r = await fetch("/api/chat/vups-v3-galax", {
    method: "POST",
    credentials: "include",
    headers: { "Content-Type": "application/json", Accept: "text/event-stream" },
    body: JSON.stringify(body)
  });
  const text = await r.text();
  return JSON.stringify({
    status: r.status,
    ct: r.headers.get("content-type"),
    rid: r.headers.get("x-request-id"),
    ms: Date.now() - started,
    head: text.slice(0, 1200),
    tail: text.slice(-400)
  });
})()`;

const targets = await (await fetch(CDP)).json();
const page =
  targets.find(t => t.type === "page" && t.url.includes(":55010") && t.webSocketDebuggerUrl) ??
  targets.find(t => t.type === "page" && t.webSocketDebuggerUrl);
if (!page) {
  console.log("no page target");
  process.exit(1);
}
console.log("target:", page.url);

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

ws.addEventListener("open", async () => {
  try {
    await send("Runtime.enable", {});
    const result = await send("Runtime.evaluate", {
      expression: EXPRESSION,
      awaitPromise: true,
      returnByValue: true
    });
    const data = JSON.parse(result.result.value);
    console.log("HTTP", data.status, "|", data.ct, "|", data.ms, "ms | requestId", data.rid);
    console.log("head:", data.head);
    console.log("tail:", data.tail);
  } catch (error) {
    console.log("cdp error:", error.message);
  } finally {
    ws.close();
  }
});
