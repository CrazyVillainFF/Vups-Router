// Navigates the live app, then reports what the native policy says.
const CDP_PORT = process.env.CDP_PORT || "9224";
const path = process.argv[2] || "/chat";
const targets = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`)).json();
const page = targets.find(t => t.type === "page" && t.webSocketDebuggerUrl);
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
  const r = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true, timeout: 30000 });
  if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails));
  return r.result.value;
};
const sleep = ms => new Promise(r => setTimeout(r, ms));

ws.addEventListener("open", async () => {
  try {
    await send("Runtime.enable", {});
    const current = await evaluate("location.pathname");
    if (current !== path) {
      await evaluate(`location.href = ${JSON.stringify(path)}; 'navigating'`).catch(e => console.log("nav warn", e.message));
      await sleep(3500);
    }
    const out = await evaluate(`(async () => {
      const invoke = window.__TAURI_INTERNALS__.invoke;
      const result = { path: location.pathname, savedMode: localStorage.getItem("vupsrouter.windows.permission-mode") };
      result.selector = document.querySelector("[aria-label^='Permission mode']")?.getAttribute("aria-label") || null;
      try {
        result.policy = await invoke("desktop_tool_policy_status");
      } catch (error) {
        result.policyError = String(error);
      }
      return JSON.stringify(result, null, 2);
    })()`);
    console.log(out);
  } catch (error) {
    console.log("ERR", error.message);
  } finally {
    ws.close();
  }
});
