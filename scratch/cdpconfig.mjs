const CDP = "http://127.0.0.1:9223/json/list";

const EXPRESSION = `(async () => {
  const out = {};
  for (const path of ["/api/settings/provider","/api/settings/shared-model","/api/settings/free-models","/api/settings/models","/api/auth/usage"]) {
    try {
      const r = await fetch(path, { credentials: "include" });
      out[path] = { status: r.status, body: (await r.text()).slice(0, 600) };
    } catch (e) { out[path] = { error: String(e) }; }
  }
  return JSON.stringify(out);
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

function send(method, params) {
  return new Promise((resolve, reject) => {
    const msgId = ++id;
    pending.set(msgId, { resolve, reject });
    ws.send(JSON.stringify({ id: msgId, method, params }));
  });
}

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
    for (const [path, value] of Object.entries(data)) {
      console.log("\n---", path, value.status ?? "error");
      console.log((value.body ?? value.error ?? "").slice(0, 600));
    }
  } catch (error) {
    console.log("cdp error:", error.message);
  } finally {
    ws.close();
  }
});
