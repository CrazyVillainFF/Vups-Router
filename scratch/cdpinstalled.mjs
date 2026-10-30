// Confirms the installed build restores the saved mode after a restart instead
// of starting with broader access, and that the native policy is really applied.
const CDP_PORT = process.env.CDP_PORT || "9224";
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

const EXPR = String.raw`(async () => {
  const invoke = window.__TAURI_INTERNALS__.invoke;
  const saved = localStorage.getItem("vupsrouter.windows.permission-mode");
  const out = { savedMode: saved };
  try {
    out.policy = await invoke("desktop_tool_policy_status");
  } catch (error) {
    out.policyError = String(error);
  }
  out.selector = document.querySelector("[aria-label^='Permission mode']")?.getAttribute("aria-label") || null;
  const ROOT = "C:/Users/Vishnu/Documents"; 
  const t0 = Date.now();
  const r = await invoke("desktop_tool_execute", { request: { tool: "get_windows_known_folder", args: { name: "downloads" } } });
  out.knownFolder = { ms: Date.now() - t0, ok: r.ok, path: r.data?.path || r.error?.message };
  return JSON.stringify(out, null, 2);
})()`;

ws.addEventListener("open", async () => {
  try {
    await send("Runtime.enable", {});
    const r = await send("Runtime.evaluate", { expression: EXPR, awaitPromise: true, returnByValue: true, timeout: 60000 });
    console.log(r.exceptionDetails ? JSON.stringify(r.exceptionDetails, null, 2) : r.result.value);
  } catch (error) {
    console.log("ERR", error.message);
  } finally {
    ws.close();
  }
});
