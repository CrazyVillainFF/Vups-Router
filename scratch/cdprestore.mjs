// Sets the saved mode to workspace with no workspace, reloads, and reports what
// the native layer really adopted.
const CDP_PORT = process.env.CDP_PORT || "9224";
const mode = process.argv[2] || "workspace";
const reload = process.argv[3] === "reload";
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

const SET_EXPR = `(async () => {
  localStorage.setItem("vupsrouter.windows.permission-mode", ${JSON.stringify(mode)});
  return localStorage.getItem("vupsrouter.windows.permission-mode");
})()`;

const READ_EXPR = `(async () => {
  const invoke = window.__TAURI_INTERNALS__.invoke;
  const out = {};
  out.savedMode = localStorage.getItem("vupsrouter.windows.permission-mode");
  out.selector = document.querySelector("[aria-label^='Permission mode']")?.getAttribute("aria-label") || null;
  try {
    out.policy = await invoke("desktop_tool_policy_status");
  } catch (error) {
    out.policyError = String(error);
  }
  return JSON.stringify(out, null, 2);
})()`;

const evaluate = async expression => {
  const r = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true, timeout: 30000 });
  if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails));
  return r.result.value;
};

ws.addEventListener("open", async () => {
  try {
    await send("Runtime.enable", {});
    if (reload) {
      console.log("saved", await evaluate(SET_EXPR));
      await evaluate("location.reload(); 'reloading'").catch(() => {});
      await new Promise(r => setTimeout(r, 4000));
    }
    console.log(await evaluate(READ_EXPR));
  } catch (error) {
    console.log("ERR", error.message);
  } finally {
    ws.close();
  }
});
