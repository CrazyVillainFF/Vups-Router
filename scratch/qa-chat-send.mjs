// QA-only: reproduces a chat turn inside the running Windows app and prints the
// raw /api/chat request body, status, and response frames.
// Usage: CDP_PORT=9224 node scratch/qa-chat-send.mjs <composerChipText> <menuItemText> <prompt>
const PORT = process.env.CDP_PORT || "9224";
const chipText = process.argv[2] || "";
const modelText = process.argv[3] || "";
const prompt = process.argv[4] || "Reply with exactly: QA turn ok";

const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
const page = list.find((t) => t.type === "page" && t.webSocketDebuggerUrl);
if (!page) {
  console.log("no page target");
  process.exit(1);
}

const ws = new WebSocket(page.webSocketDebuggerUrl);
let id = 0;
const pending = new Map();
const inflight = new Map();
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
    console.log("body:", String(params.request.postData || "").slice(0, 1500));
    inflight.set(params.requestId, {});
  }
  if (method === "Network.responseReceived" && inflight.has(params.requestId)) {
    console.log("<<< STATUS", params.response.status, params.response.headers["content-type"] || "");
    inflight.get(params.requestId).mimeType = params.response.mimeType;
  }
  if (method === "Network.loadingFinished" && inflight.has(params.requestId)) {
    const mid = ++id;
    pending.set(mid, (r) => {
      const text = r?.body ? (r.base64Encoded ? Buffer.from(r.body, "base64").toString("utf8") : r.body) : "";
      console.log(`<<< BODY (${text.length} bytes)`);
      console.log(text.slice(0, 3000));
      inflight.delete(params.requestId);
    });
    ws.send(JSON.stringify({ id: mid, method: "Network.getResponseBody", params: { requestId: params.requestId } }));
  }
});

const evaluate = async (expr) => {
  const r = await send("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true });
  if (r?.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails).slice(0, 300));
  return r?.result?.value;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function clickByText(text) {
  const box = await evaluate(
    `(() => {
      const nodes = [...document.querySelectorAll("button,[role=option],[role=menuitem],[role=button],li,div,span")]
        .filter(n => (n.textContent || "").trim() === ${JSON.stringify(text)} && n.getBoundingClientRect().width > 0);
      const node = nodes[nodes.length - 1];
      if (!node) return { found: false, count: 0 };
      node.scrollIntoView({ block: "center" });
      const r = node.getBoundingClientRect();
      return { found: true, x: r.x + r.width / 2, y: r.y + r.height / 2 };
    })()`
  );
  if (!box.found) return false;
  await sleep(150);
  for (const type of ["mousePressed", "mouseReleased"]) {
    await send("Input.dispatchMouseEvent", { type, x: box.x, y: box.y, button: "left", clickCount: 1 });
  }
  return true;
}

ws.addEventListener("open", async () => {
  await send("Runtime.enable", {});
  await send("Network.enable", { maxTotalBufferSize: 30000000 });
  await send("Page.enable", {});

  if (process.env.QA_NEW_TASK) {
    console.log("new task clicked:", await clickByText("New task"));
    await sleep(1200);
  }

  if (modelText) {
    const opened = await clickByText(chipText || modelText);
    console.log("model menu opened:", opened);
    await sleep(700);
    const picked = await clickByText(modelText);
    console.log("model picked:", picked);
    await sleep(700);
  }

  const focused = await evaluate(
    `(() => {
      const ta = document.querySelector("textarea");
      if (!ta) return false;
      ta.focus();
      return true;
    })()`
  );
  console.log("composer focused:", focused);
  await sleep(200);
  await send("Input.insertText", { text: prompt });
  await sleep(300);
  await send("Input.dispatchKeyEvent", { type: "keyDown", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 });
  await send("Input.dispatchKeyEvent", { type: "keyUp", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 });
  await sleep(30000);
  console.log("\n--- app tail ---");
  console.log(String(await evaluate("(document.body.innerText||'').replace(/\\s+/g,' ').slice(-700)")));
  ws.close();
  process.exit(0);
});
