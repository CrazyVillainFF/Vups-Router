const CDP = "http://127.0.0.1:9223/json/list";
const targets = await (await fetch(CDP)).json();
const page = targets.find((t) => t.type === "page" && t.url.includes(":55010") && t.webSocketDebuggerUrl);
const ws = new WebSocket(page.webSocketDebuggerUrl);
let id = 0;
const pending = new Map();
const send = (method, params) =>
  new Promise((resolve, reject) => {
    const msgId = ++id;
    pending.set(msgId, { resolve, reject });
    ws.send(JSON.stringify({ id: msgId, method, params }));
  });
ws.addEventListener("message", (event) => {
  const msg = JSON.parse(event.data);
  if (msg.id && pending.has(msg.id)) {
    const { resolve, reject } = pending.get(msg.id);
    pending.delete(msg.id);
    if (msg.error) reject(new Error(JSON.stringify(msg.error)));
    else resolve(msg.result);
  }
});

const EXPR = `(async () => {
  const body = {
    runId: "diag_" + Date.now(),
    messages: [{ role: "user", content: "List the 5 newest files in my Windows Downloads folder and give me their full paths." }],
    model: "vups-v3-galax",
    vups: true,
    mode: "general",
    assistantMessageId: "diag_msg_" + Date.now()
  };
  const started = Date.now();
  const r = await fetch("/api/chat/desktop-tools", {
    method: "POST",
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });
  const text = await r.text();
  return JSON.stringify({ status: r.status, ms: Date.now() - started, body: text.slice(0, 1500) });
})()`;

ws.addEventListener("open", async () => {
  try {
    await send("Runtime.enable", {});
    const r = await send("Runtime.evaluate", { expression: EXPR, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) {
      console.log("EXCEPTION", JSON.stringify(r.exceptionDetails));
    } else {
      const d = JSON.parse(r.result.value);
      console.log("HTTP", d.status, "in", d.ms, "ms");
      console.log(d.body);
    }
  } catch (e) {
    console.log("err", e.message);
  } finally {
    ws.close();
  }
});
