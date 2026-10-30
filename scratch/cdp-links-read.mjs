// Read-only link inventory probe against the running Windows app (WebView2 CDP).
const PORT = process.env.CDP_PORT || "9222";
const targets = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
const page = targets.find(t => t.type === "page" && t.webSocketDebuggerUrl);
if (!page) {
  console.log("no page target");
  process.exit(1);
}
console.log("target:", page.url, "|", page.title);
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
const evaluate = async expression => {
  const r = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true, timeout: 20000 });
  if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails));
  return r.result.value;
};
ws.addEventListener("open", async () => {
  try {
    await send("Runtime.enable", {});
    const out = await evaluate(`(() => ({
      path: location.pathname + location.search,
      nativeFlag: Boolean(window.__TAURI_INTERNALS__),
      sessionShell: (() => { try { return sessionStorage.getItem("vupsrouter.native-shell"); } catch { return "err"; } })(),
      anchors: [...document.querySelectorAll("a[href]")].slice(0, 80).map(a => ({
        text: (a.textContent || "").trim().slice(0, 40),
        href: a.getAttribute("href"),
        target: a.getAttribute("target"),
        rel: a.getAttribute("rel")
      })),
      bodyText: (document.body.innerText || "").slice(0, 400)
    }))()`);
    console.log(JSON.stringify(out, null, 2));
  } catch (error) {
    console.log("cdp error:", error.message);
  } finally {
    ws.close();
  }
});
