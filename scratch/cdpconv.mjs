const CDP = "http://127.0.0.1:9223/json/list";

const EXPRESSION = `(async () => {
  const list = await fetch("/api/conversations", { credentials: "include" });
  const listBody = await list.json();
  const items = Array.isArray(listBody.conversations) ? listBody.conversations : [];
  const recent = items.slice(0, 4);
  const detail = [];
  for (const item of recent) {
    const r = await fetch("/api/conversations/" + item.id, { credentials: "include" });
    const body = await r.json();
    const messages = Array.isArray(body.conversation?.messages) ? body.conversation.messages : [];
    detail.push({
      id: item.id,
      title: item.title,
      status: r.status,
      count: messages.length,
      shapes: messages.map(m => ({
        role: m.role,
        len: typeof m.content === "string" ? m.content.length : typeof m.content,
        hasArtifact: Boolean(m.artifact),
        status: m.status || null,
        error: m.error ? String(m.error).slice(0, 60) : null
      }))
    });
  }
  return JSON.stringify({ total: items.length, detail });
})()`;

const targets = await (await fetch(CDP)).json();
const page =
  targets.find(t => t.type === "page" && t.url.includes(":55010") && t.webSocketDebuggerUrl) ??
  targets.find(t => t.type === "page" && t.webSocketDebuggerUrl);
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
    const result = await send("Runtime.evaluate", { expression: EXPRESSION, awaitPromise: true, returnByValue: true });
    const data = JSON.parse(result.result.value);
    console.log("conversations:", data.total);
    for (const c of data.detail) {
      console.log("\n#", c.id, "|", c.status, "|", JSON.stringify(c.title), "| messages:", c.count);
      for (const m of c.shapes) console.log("   ", m.role.padEnd(9), "len=" + String(m.len).padEnd(6), "artifact=" + m.hasArtifact, "status=" + m.status, m.error ? "err=" + m.error : "");
    }
  } catch (error) {
    console.log("cdp error:", error.message);
  } finally {
    ws.close();
  }
});
