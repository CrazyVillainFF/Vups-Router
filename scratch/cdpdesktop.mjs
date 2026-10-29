// Drives the packaged Tauri app through WebView2's CDP endpoint so the request
// really travels: WebView -> 127.0.0.1 loopback server -> axum /api proxy ->
// production backend. A browser dev server cannot prove any of that.
const CDP = "http://127.0.0.1:9223";
const EMAIL = process.env.VERIFY_EMAIL;
const PASSWORD = process.env.VERIFY_PASSWORD;

const list = await (await fetch(`${CDP}/json/list`)).json();
const page = list.find(t => t.type === "page" && t.url.includes("/chat?native=windows"));
if (!page) {
  console.error("no desktop page target", list.map(t => `${t.type} ${t.url}`));
  process.exit(1);
}
console.log("target:", page.url);

const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((resolve, reject) => {
  ws.addEventListener("open", resolve, { once: true });
  ws.addEventListener("error", reject, { once: true });
});

let id = 0;
const pending = new Map();
ws.addEventListener("message", event => {
  const msg = JSON.parse(event.data);
  const settle = pending.get(msg.id);
  if (settle) {
    pending.delete(msg.id);
    settle(msg);
  }
});
const send = (method, params = {}) =>
  new Promise(resolve => {
    const next = ++id;
    pending.set(next, resolve);
    ws.send(JSON.stringify({ id: next, method, params }));
  });

const expression = `
(async () => {
  const out = { origin: location.origin, steps: [] };
  const record = (label, extra) => out.steps.push(Object.assign({ label }, extra));

  const probe = await fetch("/api/auth/probe", { method: "GET" });
  record("proxy reachable", { status: probe.status });

  let me = await fetch("/api/auth/me", { credentials: "include" });
  record("session before signin", { status: me.status });
  if (me.status !== 200) {
    const signin = await fetch("/api/auth/signin", {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: ${JSON.stringify(EMAIL)}, password: ${JSON.stringify(PASSWORD)} })
    });
    const body = await signin.text();
    record("signin", { status: signin.status, body: body.slice(0, 160) });
    me = await fetch("/api/auth/me", { credentials: "include" });
    record("session after signin", { status: me.status });
  }

  const messages = [{ role: "user", content: "Reply with exactly: VupsRouter works." }];

  const stream = async (label, path, payload) => {
    const started = performance.now();
    let res;
    try {
      res = await fetch(path, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json", Accept: "text/event-stream" },
        body: JSON.stringify(payload)
      });
    } catch (error) {
      record(label, { thrown: String(error && error.name) + ": " + String(error && error.message) });
      return;
    }
    const type = res.headers.get("content-type") || "";
    if (!type.includes("event-stream")) {
      const text = await res.text();
      record(label, { status: res.status, contentType: type, body: text.slice(0, 300) });
      return;
    }
    const reader = res.body.getReader();
    const decoder = new TextDecoder("utf-8");
    const chunks = [];
    let buffer = "";
    let firstChunkAt = 0;
    let events = [];
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!firstChunkAt) firstChunkAt = performance.now() - started;
      chunks.push(value.length);
      buffer += decoder.decode(value, { stream: true });
      let split;
      while ((split = buffer.indexOf("\\n\\n")) !== -1) {
        events.push(buffer.slice(0, split));
        buffer = buffer.slice(split + 2);
      }
    }
    buffer += decoder.decode();
    if (buffer.trim()) events.push(buffer);
    const kinds = events.map(e => (e.match(/^event:\\s*(.+)$/m) || [])[1]).filter(Boolean);
    const delta = events
      .filter(e => /^data:/m.test(e))
      .map(e => (e.match(/^data:\\s*([\\s\\S]*)$/m) || [])[1] || "")
      .join("");
    record(label, {
      status: res.status,
      ms: Math.round(performance.now() - started),
      firstChunkMs: Math.round(firstChunkAt),
      networkChunks: chunks.length,
      chunkSizes: chunks.slice(0, 12),
      eventKinds: Array.from(new Set(kinds)),
      answer: delta.slice(0, 200)
    });
  };

  await stream("vups-v3-galax", "/api/chat/vups-v3-galax", { messages, model: "vups-v3-galax", stream: true });
  await stream("shared flint", "/api/chat", { messages, model: "recursive/flint-v1.0:free", stream: true });
  return JSON.stringify(out, null, 2);
})()
`;

const result = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
if (result.error) console.log("cdp error:", JSON.stringify(result.error));
const value = result.result?.result?.value;
if (result.result?.exceptionDetails) {
  console.log("page exception:", JSON.stringify(result.result.exceptionDetails, null, 2).slice(0, 1200));
}
if (value) console.log(value);
ws.close();
