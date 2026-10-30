// QA-only: captures the real /api/chat request and response from inside the
// running Windows app, then replays the failing turn by clicking a button.
// Usage: CDP_PORT=9224 node scratch/qa-chat-capture.mjs [buttonText]
const PORT = process.env.CDP_PORT || "9224";
const clickText = process.argv[2] || "Try again";

const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
const page = list.find((t) => t.type === "page" && t.webSocketDebuggerUrl);
if (!page) {
  console.log("no page target");
  process.exit(1);
}

const ws = new WebSocket(page.webSocketDebuggerUrl);
let id = 0;
const pending = new Map();
const bodies = new Map();
const send = (method, params) =>
  new Promise((res) => {
    const m = ++id;
    pending.set(m, res);
    ws.send(JSON.stringify({ id: m, method, params }));
  });
ws.addEventListener("message", (e) => {
  const m = JSON.parse(e.data);
  if (m.id && pending.has(m.id)) {
    pending.get(m.id)(m.result);
    pending.delete(m.id);
    return;
  }
  const { method, params } = m;
  if (method === "Network.requestWillBeSent" && params.request.url.includes("/api/chat")) {
    console.log("\n>>> REQUEST", params.request.method, params.request.url);
    console.log("postData:", String(params.request.postData || "").slice(0, 1200));
    bodies.set(params.requestId, { url: params.request.url });
  }
  if (method === "Network.responseReceived" && bodies.has(params.requestId)) {
    const entry = bodies.get(params.requestId);
    entry.status = params.response.status;
    entry.headers = params.response.headers;
    console.log("<<< STATUS", params.response.status, JSON.stringify(params.response.headers).slice(0, 300));
  }
  if (method === "Network.loadingFinished" && bodies.has(params.requestId)) {
    const entry = bodies.get(params.requestId);
    send("Network.getResponseBody", { requestId: params.requestId }).then((r) => {
      const text = r?.body ? (r.base64Encoded ? Buffer.from(r.body, "base64").toString("utf8") : r.body) : "";
      console.log("<<< BODY (" + text.length + " bytes)");
      console.log(text.slice(0, 2500));
      bodies.delete(params.requestId);
    });
  }
});

const evaluate = async (expr) => {
  const r = await send("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true });
  if (r?.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails).slice(0, 300));
  return r?.result?.value;
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

ws.addEventListener("open", async () => {
  await send("Runtime.enable", {});
  await send("Network.enable", { maxTotalBufferSize: 20000000 });
  const found = await evaluate(
    `(() => {
      const nodes = [...document.querySelectorAll("button")];
      const node = nodes.find(b => (b.textContent || "").trim().startsWith(${JSON.stringify(clickText)}));
      if (!node) return { found: false, buttons: nodes.map(b => (b.textContent||"").trim()).slice(0, 12) };
      node.click();
      return { found: true, text: node.textContent.trim().slice(0, 40) };
    })()`
  );
  console.log("clicked:", JSON.stringify(found));
  if (!found.found) process.exit(0);
  await sleep(25000);
  console.log("\npage url now:", await evaluate("location.href"));
  console.log("error cards:", await evaluate(`[...document.querySelectorAll('main')].map(n=>(n.textContent||'').replace(/\\s+/g,' ').slice(-400)).join('')`));
  ws.close();
  process.exit(0);
});
