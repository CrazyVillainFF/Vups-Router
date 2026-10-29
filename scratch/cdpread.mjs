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
const EXPR = `(() => {
  const text = document.body.innerText;
  const idx = text.lastIndexOf("hii");
  return JSON.stringify({
    header: (text.match(/Chatting with[^\\n]*/) || [""])[0],
    tail: text.slice(Math.max(0, idx - 200), idx + 900).replace(/\\n{2,}/g, "\\n")
  });
})()`;
ws.addEventListener("open", async () => {
  try {
    await send("Runtime.enable", {});
    const r = await send("Runtime.evaluate", { expression: EXPR, awaitPromise: true, returnByValue: true });
    const d = JSON.parse(r.result.value);
    console.log("HEADER:", d.header);
    console.log("TEXT:\n" + d.tail);
  } catch (e) {
    console.log("err", e.message);
  } finally {
    ws.close();
  }
});
